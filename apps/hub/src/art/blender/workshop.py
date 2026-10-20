# L'atelier Blender du Directeur artistique (ADR-49), lance sans fenetre par le hub :
#   blender -b [scene.blend] --factory-startup --python workshop.py -- job.json
# Modes : prepare (importe le modele brut et le met aux mesures), python (un pas de l'artisan 3D : son code, garde par
# une liste blanche), photos (cinq vues, la scene n'est pas modifiee), export (mesures finales, .glb, photos, chiffres).
# Le hub pilote l'artisan pas a pas : il execute son code, lui rend la sortie, les mesures et les photos a regarder.
# Convention : le devant du modele regarde -Y dans Blender, soit +Z dans le .glb (Y en haut, 1 unite = 1 m).
import bpy, bmesh, sys, json, math, io, re, traceback, contextlib
from mathutils import Vector

job = json.load(open(sys.argv[sys.argv.index("--") + 1], encoding="utf-8"))
scene = bpy.context.scene


def done(result):
    json.dump(result, open(job["result"], "w", encoding="utf-8"))


# ---- Mesures ----

def meshes():
    return [o for o in scene.objects if o.type == "MESH" and not any(c.name.startswith("glTF_not_exported") for c in o.users_collection)]


def roots():
    return [o for o in scene.objects if o.parent is None and o.type not in ("CAMERA", "LIGHT")]


def triangles():
    deps = bpy.context.evaluated_depsgraph_get()
    n = 0
    for o in meshes():
        e = o.evaluated_get(deps)
        m = e.to_mesh()
        m.calc_loop_triangles()
        n += len(m.loop_triangles)
        e.to_mesh_clear()
    return n


def bounds():
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(c) for o in meshes() for c in o.bound_box]
    if not pts:
        return Vector((0, 0, 0)), Vector((0, 0, 0))
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def principled(mat):
    if not mat or not mat.use_nodes:
        return None
    return next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)


def base_image(mat):
    p = principled(mat)
    if not p or not p.inputs["Base Color"].is_linked:
        return None
    node = p.inputs["Base Color"].links[0].from_node
    return node.image if node.type == "TEX_IMAGE" else None


def materials():
    return sorted({s.material for o in meshes() for s in o.material_slots if s.material}, key=lambda m: m.name)


def summary():
    lo, hi = bounds()
    mats = []
    for m in materials():
        p = principled(m)
        val = lambda k: (None if not p else ("texture" if p.inputs[k].is_linked else (list(p.inputs[k].default_value)[:3] if hasattr(p.inputs[k].default_value, "__len__") else round(p.inputs[k].default_value, 3))))
        img = base_image(m)
        mats.append({"nom": m.name, "couleur": val("Base Color"), "metal": val("Metallic"), "rugosite": val("Roughness"), "emission": val("Emission Color"), "force_emission": val("Emission Strength"), "texture": (img.name + " %dx%d" % tuple(img.size)) if img else None})
    return {
        "triangles": triangles(),
        "dimensions_m": {"largeur_x": round(hi.x - lo.x, 3), "profondeur_y": round(hi.y - lo.y, 3), "hauteur_z": round(hi.z - lo.z, 3)},
        "au_sol": round(lo.z, 3),
        "centre_xy": [round((lo.x + hi.x) / 2, 3), round((lo.y + hi.y) / 2, 3)],
        "objets": [o.name + " (" + o.type + ")" for o in scene.objects if o.type in ("MESH", "ARMATURE", "EMPTY") and not any(c.name.startswith("glTF_not_exported") for c in o.users_collection)],
        "materiaux": mats,
        "animations": [{"nom": a.name, "images": [int(a.frame_range[0]), int(a.frame_range[1])]} for a in bpy.data.actions],
    }


def normalize(size):
    """Plus grande dimension = size metres, pose au sol (z = 0), centre en x et y."""
    lo, hi = bounds()
    if size > 0 and max(hi - lo) > 0:
        f = size / max(hi - lo)
        for o in roots():
            o.scale = o.scale * f
            o.location = o.location * f
        lo, hi = bounds()
    shift = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    for o in roots():
        o.location = o.location - shift


def budget(max_tris):
    before = triangles()
    if max_tris and before > max_tris:
        ratio = max(0.02, max_tris / before)
        for o in meshes():
            mod = o.modifiers.new("Budget", "DECIMATE")
            mod.ratio = ratio
            with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o]):
                bpy.ops.object.modifier_apply(modifier=mod.name)
    return before


# ---- Outils de l'artisan (exposes a son code) ----

def hex_rgb(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]


def linear(c):
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


def tourner(degres):
    """Tourne tout le modele autour de l'axe vertical (le devant doit regarder -Y), puis le recentre."""
    from mathutils import Matrix
    rot = Matrix.Rotation(math.radians(degres), 4, "Z")
    for o in roots():
        o.matrix_world = rot @ o.matrix_world
    normalize(0)


def matiere(rugosite=0.85, metal=0.0, materiaux=None):
    """Matiere mate : rugosite fixe, pas de metal (les reflets de Tripo font « plastique »)."""
    for m in materiaux or materials():
        p = principled(m)
        if not p:
            continue
        for k, v in (("Roughness", rugosite), ("Metallic", metal)):
            for l in list(p.inputs[k].links):
                m.node_tree.links.remove(l)
            p.inputs[k].default_value = v


def aplat(materiau, couleur, rugosite=0.85, metal=0.0):
    """Remplace la texture d'un materiau par une couleur unie (code hexadecimal)."""
    m = bpy.data.materials[materiau] if isinstance(materiau, str) else materiau
    p = principled(m)
    for l in list(p.inputs["Base Color"].links):
        m.node_tree.links.remove(l)
    p.inputs["Base Color"].default_value = linear(hex_rgb(couleur)) + [1]
    matiere(rugosite, metal, [m])


def nouveau_materiau(nom, couleur, rugosite=0.85, metal=0.0, emission=None, force=0.0):
    m = bpy.data.materials.new(nom)
    m.use_nodes = True
    p = principled(m)
    p.inputs["Base Color"].default_value = linear(hex_rgb(couleur)) + [1]
    p.inputs["Roughness"].default_value = rugosite
    p.inputs["Metallic"].default_value = metal
    if emission:
        p.inputs["Emission Color"].default_value = linear(hex_rgb(emission)) + [1]
        p.inputs["Emission Strength"].default_value = force
    return m


def _pixels(img):
    import numpy as np
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(-1, 4)


def _store(img, px):
    img.pixels.foreach_set(px.reshape(-1))
    img.update()
    img.pack()


def quantifier(palette, materiaux=None, nettoyage=2):
    """
    Ramene chaque pixel des textures a la couleur la plus proche de la palette (aplats purs, plus de bavures), puis
    efface les points isoles : chaque pixel prend la couleur majoritaire autour de lui, `nettoyage` fois.
    """
    import numpy as np
    pal = np.array([hex_rgb(c) for c in palette], dtype=np.float32)
    out = []
    for m in materiaux or materials():
        img = base_image(m)
        if not img or img.name in out:
            continue
        w, h = img.size
        px = _pixels(img)
        idx = ((px[:, None, :3] - pal[None, :, :]) ** 2).sum(axis=2).argmin(axis=1).reshape(h, w)
        for _ in range(int(nettoyage)):
            pad = np.pad(idx, 1, mode="edge")
            votes = np.zeros((len(pal), h, w), dtype=np.uint8)
            for dy in (0, 1, 2):
                for dx in (0, 1, 2):
                    win = pad[dy:dy + h, dx:dx + w]
                    for k in range(len(pal)):
                        votes[k] += win == k
            idx = votes.argmax(axis=0)
        px[:, :3] = pal[idx.reshape(-1)]
        _store(img, px)
        out.append(img.name)
    return out


def lueur(couleur, tolerance=0.15, force=4.0, materiaux=None):
    """Fait briller les zones de la texture proches de cette couleur (visiere, joints) ; le reste ne brille pas."""
    import numpy as np
    c = np.array(hex_rgb(couleur), dtype=np.float32)
    lit = 0
    for m in materiaux or materials():
        img, p = base_image(m), principled(m)
        if not img or not p:
            continue
        px = _pixels(img)
        mask = np.sqrt(((px[:, :3] - c) ** 2).sum(axis=1)) < tolerance
        glow = bpy.data.images.new(img.name + "-lueur", img.size[0], img.size[1])
        g = np.zeros_like(px)
        g[mask, :3] = px[mask, :3]
        g[:, 3] = 1
        _store(glow, g)
        node = m.node_tree.nodes.new("ShaderNodeTexImage")
        node.image = glow
        m.node_tree.links.new(node.outputs["Color"], p.inputs["Emission Color"])
        p.inputs["Emission Strength"].default_value = force
        lit += int(mask.sum())
    return lit


def boite(nom, dims, position=(0, 0, 0), materiau=None, biseau=0.0):
    """Un pave de dims (x, y, z) metres, pose sur sa base a la position donnee (objets simples)."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=(position[0], position[1], position[2] + dims[2] / 2))
    o = bpy.context.active_object
    o.name = nom
    o.scale = dims
    bpy.ops.object.transform_apply(scale=True)
    if biseau:
        mod = o.modifiers.new("Biseau", "BEVEL")
        mod.width = biseau
        mod.segments = 2
    if materiau:
        o.data.materials.append(materiau)
    return o


def cylindre(nom, rayon, hauteur, position=(0, 0, 0), materiau=None, cotes=16):
    bpy.ops.mesh.primitive_cylinder_add(vertices=cotes, radius=rayon, depth=hauteur, location=(position[0], position[1], position[2] + hauteur / 2))
    o = bpy.context.active_object
    o.name = nom
    if materiau:
        o.data.materials.append(materiau)
    return o


# ---- Photos ----

def photos(out_dir, prefix, size_hint=0):
    lo, hi = bounds()
    world = bpy.data.worlds.new("Fond")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.32, 0.33, 0.35, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.8
    scene.world = world
    sun = bpy.data.objects.new("Soleil", bpy.data.lights.new("Soleil", "SUN"))
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), 0, math.radians(35))
    scene.collection.objects.link(sun)
    center = (lo + hi) / 2
    radius = max((hi - lo).length, 0.1) * 1.6
    target = bpy.data.objects.new("Cible", None)
    target.location = center
    scene.collection.objects.link(target)
    cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
    cam.data.lens = 50
    scene.collection.objects.link(cam)
    track = cam.constraints.new("TRACK_TO")
    track.target = target
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"
    scene.camera = cam
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.image_settings.file_format = "PNG"
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"

    def shoot(path):
        scene.render.filepath = path
        try:
            bpy.ops.render.render(write_still=True)
        except Exception:
            scene.render.engine = "BLENDER_WORKBENCH"
            scene.display.shading.color_type = "TEXTURE"
            bpy.ops.render.render(write_still=True)
        return path

    out = []
    # Le devant regarde -Y : « face » est la camera placee en -Y.
    for name, deg in (("face", -90), ("trois-quarts", -45), ("profil", 0), ("dos", 90)):
        a = math.radians(deg)
        cam.location = center + Vector((math.cos(a) * radius, math.sin(a) * radius, radius * 0.45))
        out.append(shoot("%s/%s-%s.png" % (out_dir, prefix, name)))
    # Vue de jeu : de haut et de loin, sur un sol sombre, comme la camera d'un jeu en 3/4 de dessus.
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, 0))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new("Sol")
    gm.use_nodes = True
    principled(gm).inputs["Base Color"].default_value = linear(hex_rgb("#30353C")) + [1]
    principled(gm).inputs["Roughness"].default_value = 1
    ground.data.materials.append(gm)
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.02, 0.025, 0.03, 1)
    far = max(max(hi - lo), 0.5) * 3.2
    cam.location = center + Vector((far * 0.35, -far * 0.6, far * 0.75))
    out.append(shoot("%s/%s-vue-jeu.png" % (out_dir, prefix)))
    return out


# ---- Modes ----

SAFE_MODULES = {"bpy", "bmesh", "mathutils", "math", "random", "numpy", "colorsys", "itertools", "functools", "collections", "re", "json"}
FORBIDDEN = re.compile(r"__|\bos\b|\bsys\b|subprocess|socket|urllib|http|requests|ctypes|shutil|importlib|pathlib|\bopen\s*\(|\beval\s*\(|\bexec\s*\(|\bcompile\s*\(|\bglobals\s*\(|\bvars\s*\(|bpy\.ops\.wm\b|bpy\.ops\.preferences|bpy\.ops\.script|bpy\.ops\.import_|bpy\.ops\.export_|bpy\.ops\.image\.(save|open|reload)|bpy\.utils|bpy\.app|\.filepath|libraries|addon|url_open|text_editor|bpy\.data\.texts")


def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    if name.split(".")[0] not in SAFE_MODULES:
        raise ImportError("module interdit dans l'atelier : " + name)
    return __import__(name, globals, locals, fromlist, level)


def run_code(code):
    bad = FORBIDDEN.search(code)
    if bad:
        return {"ok": False, "sortie": "", "erreur": "Refuse par l'atelier : « %s » n'est pas permis (fichiers, systeme, reseau et modules autres que bpy, bmesh, mathutils, numpy et les modules de calcul)." % bad.group(0)}
    import builtins
    safe = {k: getattr(builtins, k) for k in dir(builtins) if k not in ("open", "eval", "exec", "compile", "__import__", "input", "breakpoint", "globals", "vars", "memoryview", "help", "exit", "quit")}
    safe["__import__"] = guarded_import
    env = {"__builtins__": safe, "bpy": bpy, "bmesh": bmesh, "Vector": Vector, "math": math}
    for k in ("meshes", "triangles", "bounds", "materials", "summary", "normalize", "budget", "tourner", "matiere", "aplat", "nouveau_materiau", "quantifier", "lueur", "boite", "cylindre", "base_image"):
        env[k] = globals()[k]
    env["mesures"] = summary
    env["palette"] = job.get("palette", [])
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            exec(compile(code, "atelier", "exec"), env)
    except Exception:
        return {"ok": False, "sortie": buf.getvalue()[-4000:], "erreur": traceback.format_exc(limit=4)[-3000:]}
    return {"ok": True, "sortie": buf.getvalue()[-6000:], "erreur": None}


def import_raw():
    bpy.ops.import_scene.gltf(filepath=job["input"])
    names = job.get("animations") or []

    def name_new(actions, name):
        for a in actions:
            a.name = name if len(actions) == 1 else "%s_%s" % (name, a.name)
            a.use_fake_user = True

    if names:
        name_new(list(bpy.data.actions), names[0])
    # Animations suivantes (meme squelette) : on garde l'action, on jette le reste du fichier.
    for i, extra in enumerate(job.get("extras") or []):
        objs, acts = set(bpy.data.objects), set(bpy.data.actions)
        bpy.ops.import_scene.gltf(filepath=extra)
        name_new([a for a in bpy.data.actions if a not in acts], names[i + 1] if i + 1 < len(names) else "anim_%d" % (i + 2))
        for o in [o for o in bpy.data.objects if o not in objs]:
            bpy.data.objects.remove(o, do_unlink=True)
    for arm in [o for o in scene.objects if o.type == "ARMATURE"]:
        arm.animation_data_create()
        arm.animation_data.action = None
        for a in bpy.data.actions:
            track = arm.animation_data.nla_tracks.new()
            track.name = a.name
            track.strips.new(a.name, 0, a)
    if not meshes():
        raise SystemExit("aucun maillage dans le modele")


def shrink_textures(limit):
    for img in bpy.data.images:
        w, h = img.size
        if limit and max(w, h) > limit:
            k = limit / max(w, h)
            img.scale(max(1, int(w * k)), max(1, int(h * k)))
        if img.size[0] and not img.packed_file:
            img.pack()


mode = job["mode"]
if mode == "prepare":
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    if job.get("input"):
        import_raw()
        budget(int(job.get("max_tris") or 0))
        normalize(float(job.get("size") or 0))
        shrink_textures(int(job.get("max_texture") or 0))
    bpy.ops.wm.save_as_mainfile(filepath=job["blend"])
    done(summary())
elif mode == "python":
    r = run_code(job["code"])
    if r["ok"]:
        bpy.ops.wm.save_as_mainfile(filepath=job["blend"])
    done(r)
elif mode == "photos":
    done({"photos": photos(job["out_dir"], job["prefix"]), "mesures": summary()})
elif mode == "export":
    before = budget(int(job.get("max_tris") or 0))
    normalize(float(job.get("size") or 0))
    shrink_textures(int(job.get("max_texture") or 0))
    has_anim = any(o.type == "ARMATURE" and o.animation_data and o.animation_data.nla_tracks for o in scene.objects)
    bpy.ops.export_scene.gltf(filepath=job["output"], export_format="GLB", export_yup=True, export_animations=True, export_animation_mode="NLA_TRACKS" if has_anim else "ACTIONS", export_apply=False)
    s = summary()
    lo, hi = bounds()
    renders = photos(job["out_dir"], job["prefix"])
    done({"renders": renders, "tris_before": before, "tris_after": s["triangles"], "dims": list(hi - lo), "animations": [a.name for a in bpy.data.actions], "materiaux": s["materiaux"]})
