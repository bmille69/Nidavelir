# L'atelier Blender du Directeur artistique (ADR-49), lance sans fenetre par le hub :
#   blender -b [scene.blend] --factory-startup --python workshop.py -- job.json
# Modes : prepare (importe le modele brut et le met aux mesures), python (un pas de l'artisan 3D : son code, garde par
# une liste blanche), photos (cinq vues, la scene n'est pas modifiee), export (mesures finales, .glb, photos, chiffres),
# restaurer (la scene revient a une copie gardee, ADR-116).
# Le hub pilote l'artisan pas a pas : il execute son code, lui rend la sortie, les mesures et les photos a regarder.
# Convention : le devant du modele regarde -Y dans Blender, soit +Z dans le .glb (Y en haut, 1 unite = 1 m).
import bpy, bmesh, sys, os, json, math, io, re, traceback, contextlib
from mathutils import Vector

job = json.load(open(sys.argv[sys.argv.index("--") + 1], encoding="utf-8"))
scene = bpy.context.scene


def done(result):
    json.dump(result, open(job["result"], "w", encoding="utf-8"))


# ---- Mesures ----

def all_meshes():
    return [o for o in scene.objects if o.type == "MESH" and not any(c.name.startswith("glTF_not_exported") for c in o.users_collection)]


def meshes():
    """Le modele. En mode figurine (ADR-53), le corps de Tripo n'est qu'un calque : on compte les pieces, s'il y en a."""
    pieces = [o for o in all_meshes() if not o.get("calque")]
    return pieces or all_meshes()


def armature():
    return next((o for o in scene.objects if o.type == "ARMATURE"), None)


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


def _parts(bm):
    """Les morceaux d'un maillage : listes de faces reliees par leurs aretes."""
    seen, parts = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        seen.add(f.index)
        part, stack = [], [f]
        while stack:
            g = stack.pop()
            part.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        parts.append(part)
    return parts


def _check(o, fix=False):
    deps = bpy.context.evaluated_depsgraph_get()
    bm = bmesh.new()
    if fix:
        bm.from_mesh(o.data)
    else:
        bm.from_object(o, deps)
    bm.faces.ensure_lookup_table()
    nulles = [f for f in bm.faces if f.calc_area() < 1e-10]
    ouvertes = sum(1 for e in bm.edges if e.link_faces and not e.is_manifold)
    parts = _parts(bm)
    lo, hi = bounds()
    diag = max((hi - lo).length, 1e-6)
    retournees, petits = 0, []
    for part in parts:
        vs = {v for f in part for v in f.verts}
        plo = Vector((min(v.co.x for v in vs), min(v.co.y for v in vs), min(v.co.z for v in vs)))
        phi = Vector((max(v.co.x for v in vs), max(v.co.y for v in vs), max(v.co.z for v in vs)))
        if len(parts) > 1 and (phi - plo).length * max(o.scale) < 0.02 * diag:
            petits.append(part)
            continue
        # Faces a l'envers : seulement sur un morceau ferme, ou « dedans » et « dehors » ont un sens.
        if all(e.is_manifold for f in part for e in f.edges):
            before = [f.normal.copy() for f in part]
            bmesh.ops.recalc_face_normals(bm, faces=part)
            retournees += sum(1 for f, n in zip(part, before) if f.normal.dot(n) < 0)
    if fix:
        if petits:
            bmesh.ops.delete(bm, geom=list({f for p in petits for f in p}), context="FACES")
        bmesh.ops.dissolve_degenerate(bm, edges=bm.edges[:], dist=1e-6)
        bm.to_mesh(o.data)
        o.data.update()
    bm.free()
    return {"faces_retournees": retournees, "petits_morceaux": len(petits), "faces_nulles": len(nulles), "aretes_ouvertes": ouvertes, "morceaux": len(parts)}


def controle():
    """Les defauts invisibles sur une photo (ADR-63) : faces a l'envers, petits morceaux detaches, faces nulles, aretes ouvertes."""
    out = {"faces_retournees": 0, "petits_morceaux": 0, "faces_nulles": 0, "aretes_ouvertes": 0, "objets": []}
    for o in meshes():
        c = _check(o)
        for k in ("faces_retournees", "petits_morceaux", "faces_nulles", "aretes_ouvertes"):
            out[k] += c[k]
        if c["faces_retournees"] or c["petits_morceaux"] or c["faces_nulles"]:
            out["objets"].append({"nom": o.name, **c})
    return out


def reparer():
    """Remet les faces a l'endroit, supprime les petits morceaux detaches et les faces nulles ; rend le controle d'apres."""
    for o in meshes():
        _check(o, fix=True)
    return controle()


def _image_ok(img):
    """Une image de texture qui se rend : emballee, generee, ou son fichier present. Sinon Blender la peint en magenta."""
    if img is None:
        return False
    if img.packed_file or img.source == "GENERATED":
        return True
    path = bpy.path.abspath(img.filepath) if img.filepath else ""
    return bool(path) and os.path.exists(path)


def _lit_part(img):
    """Part des pixels allumes d'un masque de lueur (0 a 1)."""
    try:
        import numpy as np
        px = _pixels(img)
        return float((px[:, :3].max(axis=1) > 0.02).mean()) if len(px) else 0.0
    except Exception:
        return 1.0


def _emissive(m):
    """Part du materiau qui brille (0 a 1) : emission non nulle, masque de lueur compris, ou nœud d'emission."""
    if not m or not m.use_nodes:
        return 0.0
    p = principled(m)
    if p:
        strength = p.inputs["Emission Strength"]
        if not strength.is_linked and strength.default_value <= 0:
            return 0.0
        color = p.inputs["Emission Color"]
        if color.is_linked:
            node = color.links[0].from_node
            return _lit_part(node.image) if node.type == "TEX_IMAGE" and node.image else 1.0
        return 1.0 if max(list(color.default_value)[:3]) > 0.001 else 0.0
    for n in m.node_tree.nodes:
        if n.type == "EMISSION" and n.outputs[0].is_linked and (n.inputs["Strength"].is_linked or n.inputs["Strength"].default_value > 0):
            return 1.0
    return 0.0


def sante():
    """La sante de la scene, sans LLM (ADR-116) : textures presentes ou manquantes, part de la surface texturee et
    brillante (ponderee par l'aire), materiaux, triangles. Le hub compare avant et apres chaque code de l'artisan."""
    mats = materials()
    presentes, manquantes = set(), 0
    for m in mats:
        if not m.use_nodes:
            continue
        for n in m.node_tree.nodes:
            # Un noeud image branche : vide ou image absente, le rendu est magenta.
            if n.type == "TEX_IMAGE" and any(o.is_linked for o in n.outputs):
                if _image_ok(n.image):
                    presentes.add(n.image.name)
                else:
                    manquantes += 1
    glow = {m.name: _emissive(m) for m in mats}
    textured = {m.name: bool(base_image(m)) and _image_ok(base_image(m)) for m in mats}
    total = lit = tex = 0.0
    for o in meshes():
        k = abs(o.matrix_world.to_3x3().determinant()) ** (2.0 / 3.0)
        slots = [s.material for s in o.material_slots]
        for f in o.data.polygons:
            a = f.area * k
            m = slots[f.material_index] if f.material_index < len(slots) else None
            total += a
            if m:
                lit += a * glow.get(m.name, 0.0)
                tex += a if textured.get(m.name) else 0.0
    pct = lambda x: round(100.0 * x / total, 1) if total else 0.0
    return {"textures": len(presentes), "textures_manquantes": manquantes, "part_texturee": pct(tex), "part_emissive": pct(lit), "materiaux": len(mats), "triangles": triangles()}


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
        "controle": controle(),
        "sante": sante(),
    }


def animations():
    """Les animations du modele : nom, debut et fin en secondes, duree (ADR-56)."""
    fps = scene.render.fps
    return [{"nom": a.name, "debut_s": round(a.frame_range[0] / fps, 2), "fin_s": round(a.frame_range[1] / fps, 2), "duree_s": round((a.frame_range[1] - a.frame_range[0]) / fps, 2)} for a in bpy.data.actions]


def box(o):
    pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
    return Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts))), Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))


def kit_pieces():
    """Un kit : plusieurs pieces sans squelette, ecartees cote a cote (boites disjointes vues de dessus). Sinon []."""
    if armature():
        return []
    bpy.context.view_layer.update()
    boxes = [box(o) for o in meshes()]
    if len(boxes) < 2:
        return []
    for i, (alo, ahi) in enumerate(boxes):
        for blo, bhi in boxes[i + 1:]:
            if alo.x < bhi.x and blo.x < ahi.x and alo.y < bhi.y and blo.y < ahi.y:
                return []
    return boxes


def normalize(size):
    """Plus grande dimension = size metres, pose au sol (z = 0), centre en x et y. Pour un kit, c'est la plus grande PIECE
    qui mesure size : la rangee des pieces ecartees pour les photos n'est pas un objet du jeu."""
    lo, hi = bounds()
    pieces = kit_pieces()
    longest = max(max(phi - plo) for plo, phi in pieces) if pieces else max(hi - lo)
    if size > 0 and longest > 0:
        f = size / longest
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


# ---- Facettes (ADR-114) ----
# Tripo livre un modele low-poly regle pour paraitre LISSE (toutes ses faces lissees, normales personnalisees) : les facettes
# fondent l'une dans l'autre et sa peinture deborde d'une face sur l'autre, les « aretes baveuses ». Un style a facettes
# veut l'inverse : chaque face plate, l'arete franche.

def facettes(oui=True, auto=False):
    """Facettes nettes (oui) ou modele lisse (non). auto : seulement si l'artisan n'a encore rien choisi."""
    if auto and "facettes" in scene:
        return bool(scene["facettes"])
    for o in meshes():
        if o.get("calque"):
            continue
        me = o.data
        if oui:
            me.polygons.foreach_set("use_smooth", [False] * len(me.polygons))
            if me.has_custom_normals:
                with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o]):
                    bpy.ops.mesh.customdata_custom_splitnormals_clear()
        else:
            me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
        me.update()
    scene["facettes"] = bool(oui)
    return bool(oui)


_OK1 = ((0.4122214708, 0.5363325363, 0.0514459929), (0.2119034982, 0.6806995451, 0.1073969566), (0.0883024619, 0.2817188376, 0.6299787005))
_OK2 = ((0.2104542553, 0.7936177850, -0.0040720468), (1.9779984951, -2.4285922050, 0.4505937099), (0.0259040371, 0.7827717662, -0.8086757660))


def _oklab(rgb):
    import numpy as np
    c = np.clip(rgb, 0, 1)
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return np.cbrt(c @ np.array(_OK1).T) @ np.array(_OK2).T


def _kmeans(x, k, it=8):
    import numpy as np
    order = np.argsort(x[:, 0])
    c = x[order[np.linspace(0, len(x) - 1, k).astype(int)]].copy()
    lab = np.zeros(len(x), int)
    for _ in range(it):
        lab = ((x[:, None] - c[None]) ** 2).sum(2).argmin(1)
        for j in range(k):
            if (lab == j).any():
                c[j] = np.median(x[lab == j], axis=0)
    return c, lab


def nettoyer_texture(seuil=0.05, couleurs_permises=None, auto=False):
    """La peinture de Tripo, nette facette par facette (ADR-114). Tripo peint son modele detaille puis la reporte sur le
    low-poly : des taches floues qui chevauchent les facettes, du grain, des degrades. Chaque facette d'une seule couleur
    (ecart sous `seuil`, en Oklab) devient un aplat ; une facette qui porte un detail (veine, oeil, rivet) garde ses deux
    ou trois couleurs, avec des frontieres franches. Une couleur proche de la palette s'y aligne. Les UV ne bougent pas :
    rien n'est perdu de ce que Tripo a dessine. auto : seulement si ce n'est pas deja fait. Rend le nombre de facettes par cas."""
    import numpy as np
    if auto and scene.get("texture_nettoyee"):
        return None
    pal_hex = [h for h in (couleurs_permises or job.get("palette") or [])]
    pal = np.array([hex_rgb(h) for h in pal_hex], dtype=np.float64) if pal_hex else None
    pal_lab = _oklab(pal) if pal is not None else None
    stats = {"aplats": 0, "deux": 0, "trois": 0}
    done = set()
    for o in meshes():
        if o.get("calque"):
            continue
        me = o.data
        uvl = me.uv_layers.active
        if not uvl:
            continue
        uv = np.empty(len(me.loops) * 2, dtype=np.float64)
        uvl.data.foreach_get("uv", uv)
        uv = uv.reshape(-1, 2)
        for si, sl in enumerate(o.material_slots):
            m = sl.material
            if not m or not m.use_nodes:
                continue
            bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            lk = bsdf.inputs["Base Color"].links if bsdf else []
            img = lk[0].from_node.image if lk and lk[0].from_node.type == "TEX_IMAGE" else None
            if not img or not img.size[0] or img.name in done:
                continue
            done.add(img.name)
            W, H = img.size
            px = np.empty(W * H * 4, dtype=np.float32)
            img.pixels.foreach_get(px)
            px = px.reshape(H, W, 4)
            rgb = px[:, :, :3].astype(np.float64)
            outp = rgb.copy()
            owner = np.zeros((H, W), bool)
            for p in me.polygons:
                if p.material_index != si:
                    continue
                pts = uv[list(p.loop_indices)] * [W, H]
                x0, y0 = np.floor(pts.min(0) - 2).astype(int)
                x1, y1 = np.ceil(pts.max(0) + 2).astype(int)
                x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, W - 1), min(y1, H - 1)
                if x1 <= x0 or y1 <= y0:
                    continue
                gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
                inside = np.zeros(gx.shape, bool)
                near = np.zeros(gx.shape, bool)
                for t in range(1, len(pts) - 1):
                    A, B, C = pts[0], pts[t], pts[t + 1]
                    d = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1])
                    if abs(d) < 1e-9:
                        continue
                    l1 = ((B[1] - C[1]) * (gx - C[0]) + (C[0] - B[0]) * (gy - C[1])) / d
                    l2 = ((C[1] - A[1]) * (gx - C[0]) + (A[0] - C[0]) * (gy - C[1])) / d
                    l3 = 1 - l1 - l2
                    inside |= (l1 >= 0) & (l2 >= 0) & (l3 >= 0)
                    e = 2.5 / max(1.0, abs(d) ** 0.5)   # ~2 px de marge : le filtrage lit un peu au-dela du bord
                    near |= (l1 >= -e) & (l2 >= -e) & (l3 >= -e)
                if not inside.any():
                    inside = near
                if not near.any():
                    continue
                sub = rgb[y0:y1 + 1, x0:x1 + 1]
                core = sub[inside]
                lab = _oklab(core)
                spread = np.percentile(np.linalg.norm(lab - np.median(lab, 0), axis=1), 85)
                assign = np.zeros(int(near.sum()), int)
                cols = np.array([np.median(core, 0)])
                if spread >= seuil and len(core) >= 12:
                    c2, a2 = _kmeans(lab, 2)
                    if np.linalg.norm(c2[0] - c2[1]) >= seuil * 1.5:
                        c3, a3 = _kmeans(lab, 3)
                        dmin = min(np.linalg.norm(c3[i] - c3[j]) for i in range(3) for j in range(i + 1, 3))
                        if dmin > seuil * 2 and min(np.bincount(a3, minlength=3)) > 0.08 * len(lab):
                            cen, al, k = c3, a3, 3
                        else:
                            cen, al, k = c2, a2, 2
                        cols = np.array([np.median(core[al == j], 0) if (al == j).any() else core.mean(0) for j in range(k)])
                        grid = np.full(near.shape, -1)
                        grid[near] = ((_oklab(sub[near])[:, None] - cen[None]) ** 2).sum(2).argmin(1)
                        g2 = grid.copy()   # filtre majoritaire 3x3 : pas de pixel isole
                        for yy, xx in zip(*np.nonzero(near)):
                            w_ = grid[max(0, yy - 1):yy + 2, max(0, xx - 1):xx + 2].ravel()
                            g2[yy, xx] = np.bincount(w_[w_ >= 0]).argmax()
                        assign = g2[near]
                if len(cols) == 1:
                    stats["aplats"] += 1
                else:
                    stats["deux" if len(cols) == 2 else "trois"] += 1
                if pal is not None:
                    for j in range(len(cols)):
                        dd = np.linalg.norm(pal_lab - _oklab(cols[j][None]), axis=1)
                        if dd.min() < 0.05:
                            cols[j] = pal[dd.argmin()]
                vals = cols[assign]
                blk = outp[y0:y1 + 1, x0:x1 + 1]
                own = owner[y0:y1 + 1, x0:x1 + 1]
                is_core = inside[near]
                for q, (yy, xx) in enumerate(zip(*np.nonzero(near))):
                    if is_core[q]:   # le coeur d'une facette l'emporte sur la marge d'une voisine
                        blk[yy, xx] = vals[q]
                        own[yy, xx] = True
                    elif not own[yy, xx]:
                        blk[yy, xx] = vals[q]
            px[:, :, :3] = outp
            img.pixels.foreach_set(px.ravel())
            img.pack()
    scene["texture_nettoyee"] = True
    return stats


def aplats_facettes(couleurs_permises=None, lueur_hex=None):
    """Une couleur unie par facette, choisie dans la palette par vote sur la peinture de Tripo au coeur de la facette
    (jamais sur ses bords, la ou elle bave), puis une facette isolee prend la couleur de ses voisines. Pour un modele aux
    grandes zones de couleur seulement : les details plus fins qu'une facette (veines, runes, motifs) disparaissent.
    Rend le nombre de facettes repeintes par couleur."""
    import numpy as np
    pal_hex = [h.upper() for h in (couleurs_permises or job.get("palette") or [])]
    if not pal_hex:
        raise ValueError("aucune palette : passe couleurs_permises=[\"#RRGGBB\", ...]")
    pal = np.array([hex_rgb(h) for h in pal_hex], dtype=np.float32)
    glow = pal_hex.index(lueur_hex.upper()) if lueur_hex and lueur_hex.upper() in pal_hex else None
    facettes(True)
    compte = {}
    for o in meshes():
        if o.get("calque"):
            continue
        me = o.data
        uvl = me.uv_layers.active
        if not uvl:
            continue
        slots = {}
        for i, sl in enumerate(o.material_slots):
            m = sl.material
            if not m or not m.use_nodes:
                continue
            img = next((n.image for n in m.node_tree.nodes if n.type == "TEX_IMAGE" and n.image), None)
            if img and img.size[0] * img.size[1] > 0:
                w, h = img.size
                a = np.empty(w * h * 4, dtype=np.float32)
                img.pixels.foreach_get(a)
                slots[i] = (m, img, a.reshape(h, w, 4))
        glow_slots = {i for i, sl in enumerate(o.material_slots) if sl.material and i not in slots and glow is not None}
        faces = [p for p in me.polygons if p.material_index in slots or p.material_index in glow_slots]
        if not faces or not slots:
            continue
        uv = np.empty(len(me.loops) * 2, dtype=np.float32)
        uvl.data.foreach_get("uv", uv)
        uv = uv.reshape(-1, 2)
        colors = []
        for p in faces:
            if p.material_index in glow_slots:
                colors.append(glow)
                continue
            px = slots[p.material_index][2]
            h, w = px.shape[:2]
            pts = uv[list(p.loop_indices)]
            c = pts.mean(axis=0)
            samp = [c] + [c + 0.5 * (q - c) for q in pts] + [c + 0.25 * (q - c) for q in pts]
            cols = np.array([px[min(h - 1, max(0, int((v % 1) * h))), min(w - 1, max(0, int((u % 1) * w))), :3] for u, v in samp])
            votes = np.bincount(((cols[:, None, :] - pal[None]) ** 2).sum(2).argmin(1), minlength=len(pal))
            colors.append(int(votes.argmax()))
        # voisines par arete, comparees en positions : le maillage de Tripo est coupe a chaque couture des UV
        co = [tuple(round(x, 4) for x in v.co) for v in me.vertices]
        edges = {}
        for k, p in enumerate(faces):
            vs = [co[i] for i in p.vertices]
            for a, b in zip(vs, vs[1:] + vs[:1]):
                edges.setdefault(frozenset((a, b)), []).append(k)
        neigh = [set() for _ in faces]
        for fs in edges.values():
            for a in fs:
                neigh[a].update(x for x in fs if x != a)
        for _ in range(3):
            new = list(colors)
            for k, nb in enumerate(neigh):
                if nb:
                    v = np.bincount([colors[j] for j in nb], minlength=len(pal))
                    if v[colors[k]] <= 1 and v.max() >= 2 and v.argmax() != colors[k]:
                        new[k] = int(v.argmax())
            colors = new
        tex_slot = next(iter(slots))
        for k, p in enumerate(faces):
            if glow is not None and p.material_index in glow_slots and colors[k] != glow:
                p.material_index = tex_slot
            elif glow is not None and p.material_index not in glow_slots and colors[k] == glow and glow_slots:
                p.material_index = min(glow_slots)
        # un atlas de petites cases unies, chaque facette pointe le centre de sa case (filtrage au plus proche)
        cell, g = 4, math.ceil(math.sqrt(len(faces)))
        size = g * cell
        atlas = np.ones((size, size, 4), dtype=np.float32)
        new_uv = uv.copy()
        for k, p in enumerate(faces):
            gx, gy = k % g, k // g
            atlas[gy * cell:(gy + 1) * cell, gx * cell:(gx + 1) * cell, :3] = pal[colors[k]]
            for li in p.loop_indices:
                new_uv[li] = ((gx + 0.5) / g, (gy + 0.5) / g)
            compte[pal_hex[colors[k]]] = compte.get(pal_hex[colors[k]], 0) + 1
        uvl.data.foreach_set("uv", new_uv.reshape(-1))
        image = bpy.data.images.new(o.name[:40] + "_facettes", size, size)
        image.pixels.foreach_set(atlas.reshape(-1))
        image.pack()
        for m, img, _ in slots.values():
            nodes, links = m.node_tree.nodes, m.node_tree.links
            bsdf = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
            if bsdf:
                for l in list(bsdf.inputs["Normal"].links):
                    links.remove(l)
            for n in nodes:
                if n.type == "TEX_IMAGE" and n.image == img:
                    n.image = image
                    n.interpolation = "Closest"
    return compte


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


def _metal(m):
    """Le metal d'un materiau, pixel par pixel aux dimensions de sa texture de couleur (canal de la carte ORM de glTF), ou None."""
    import numpy as np
    p, img = principled(m), base_image(m)
    if not p or not img or not p.inputs["Metallic"].is_linked:
        return None
    link = p.inputs["Metallic"].links[0]
    node, ch = link.from_node, 0
    if node.type in ("SEPARATE_COLOR", "SEPRGB"):
        ch = {"Red": 0, "R": 0, "Green": 1, "G": 1, "Blue": 2, "B": 2}.get(link.from_socket.name, 2)
        node = node.inputs[0].links[0].from_node if node.inputs[0].is_linked else None
    if not node or node.type != "TEX_IMAGE" or not node.image:
        return None
    src = node.image
    w, h = src.size
    W, H = img.size
    a = _pixels(src)[:, ch].reshape(h, w)
    return a[(np.arange(H) * h) // H][:, (np.arange(W) * w) // W].reshape(-1)


def matiere(rugosite=0.85, metal=0.0, materiaux=None, assombrir=0.35):
    """
    Matiere mate : rugosite fixe, pas de metal (les reflets de Tripo font « plastique »). Ce qui etait du metal prend sa
    couleur de base comme une peinture mate, bien plus claire : on l'assombrit d'autant (assombrir=0 pour ne pas toucher).
    """
    for m in materiaux or materials():
        p = principled(m)
        if not p:
            continue
        if assombrir and metal < 0.5:
            mm = _metal(m)
            if mm is not None:
                img = base_image(m)
                px = _pixels(img)
                px[:, :3] *= (1 - assombrir * mm)[:, None]
                _store(img, px)
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


def _visibles(m, img):
    """Les pixels de la texture que le modele montre vraiment (aux coordonnees UV de ses faces), sans les vides de l'atlas."""
    import numpy as np
    w, h = img.size
    idx = []
    for o in all_meshes():
        if m.name not in [s.material.name for s in o.material_slots if s.material] or not o.data.uv_layers.active:
            continue
        uv = np.empty(len(o.data.loops) * 2, dtype=np.float32)
        o.data.uv_layers.active.data.foreach_get("uv", uv)
        uv = uv.reshape(-1, 2) % 1.0
        idx.append((uv[:, 1] * (h - 1)).astype(np.int64) * w + (uv[:, 0] * (w - 1)).astype(np.int64))
    return np.concatenate(idx) if idx else None


def couleurs(n=10, materiaux=None):
    """
    Les couleurs que le modele montre (code, part de la surface en %), les plus presentes d'abord : pour savoir de quelle
    couleur est vraiment peinte une piece (une visiere ambre, une armure bleutee) avant de la teinter ou de la faire briller.
    """
    import numpy as np
    out = []
    for m in materiaux or materials():
        img = base_image(m)
        if not img:
            continue
        px = _pixels(img)[:, :3]
        idx = _visibles(m, img)
        if idx is not None:
            px = px[idx]
        q = np.clip(np.round(px * 15), 0, 15).astype(np.int64)
        key = q[:, 0] * 256 + q[:, 1] * 16 + q[:, 2]
        vals, counts = np.unique(key, return_counts=True)
        for k in np.argsort(-counts)[:n]:
            c = px[key == vals[k]].mean(axis=0)
            out.append({"materiau": m.name, "couleur": "#%02X%02X%02X" % tuple(int(round(float(x) * 255)) for x in c), "part": round(100.0 * counts[k] / len(key), 2)})
    return out


def teinter(de, vers, tolerance=0.15, force=1.0, materiaux=None):
    """
    Decale les zones de la texture proches de la couleur « de » vers la couleur « vers », en gardant leurs details
    (ombres, gravures, rivets) : on deplace leur teinte moyenne, on ne repeint pas. Rend le nombre de pixels touches.
    """
    import numpy as np
    c, t = np.array(hex_rgb(de), dtype=np.float32), np.array(hex_rgb(vers), dtype=np.float32)
    touched = 0
    for m in materiaux or materials():
        img = base_image(m)
        if not img:
            continue
        px = _pixels(img)
        d = np.sqrt(((px[:, :3] - c) ** 2).sum(axis=1))
        mask = d < tolerance
        if not mask.any():
            continue
        # Plein effet au coeur de la zone, fondu sur ses bords : pas de frontiere nette entre pixels touches ou non.
        wgt = np.clip((1 - d / tolerance) * 2, 0, 1)[:, None] * force
        px[:, :3] = np.clip(px[:, :3] + wgt * (t - px[mask, :3].mean(axis=0)), 0, 1)
        _store(img, px)
        touched += int(mask.sum())
    return touched


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


# ---- Figurine (ADR-53) : des pieces nettes accrochees aux os du squelette de Tripo ----

def marquer_calque():
    """Le corps de Tripo devient un calque : cache aux photos et a l'export, il sert seulement de guide de taille."""
    n = 0
    for o in all_meshes():
        if any(m.type == "ARMATURE" for m in o.modifiers) or o.vertex_groups:
            o["calque"] = True
            o.hide_render = True
            o.display_type = "WIRE"
            n += 1
    return n


def calque(visible=True):
    """Montre (ou cache) le calque sur les photos, pour comparer les pieces au corps de Tripo."""
    for o in all_meshes():
        if o.get("calque"):
            o.hide_render = not visible


def squelette():
    """Les os : nom, tete et queue (metres, monde, pose de repos), longueur. Les pieces s'accrochent a ces os."""
    arm = armature()
    if not arm:
        return []
    r = lambda v: [round(x, 3) for x in v]
    return [{"nom": b.name, "tete": r(arm.matrix_world @ b.head_local), "queue": r(arm.matrix_world @ b.tail_local), "longueur": round(b.length * arm.matrix_world.to_scale()[0], 3)} for b in arm.data.bones]


def zones():
    """
    Pour chaque os, la boite du calque qu'il porte (centre et dimensions en metres) : ou poser et quelle taille donner a
    la piece. Chaque point du calque va a l'os qui le tient le plus ; les os de torsion (« L_UpperarmTwist01 ») comptent
    pour leur os principal (« L_Upperarm »).
    """
    arm = armature()
    bones = set(arm.data.bones.keys()) if arm else set()

    def main(name):
        base = re.sub(r"Twist\d+$", "", name)
        return base if base in bones else name

    out = {}
    for o in all_meshes():
        if not o.get("calque"):
            continue
        names = {g.index: g.name for g in o.vertex_groups}
        pts = {}
        for v in o.data.vertices:
            best = max((g for g in v.groups if g.group in names), key=lambda g: g.weight, default=None)
            if best and best.weight > 0:
                pts.setdefault(main(names[best.group]), []).append(o.matrix_world @ v.co)
        for name, ps in pts.items():
            lo = Vector((min(p.x for p in ps), min(p.y for p in ps), min(p.z for p in ps)))
            hi = Vector((max(p.x for p in ps), max(p.y for p in ps), max(p.z for p in ps)))
            out[name] = {"centre": [round(x, 3) for x in (lo + hi) / 2], "dimensions": [round(x, 3) for x in hi - lo], "points": len(ps)}
    return out


def fixer(objet, sur):
    """Accroche une piece a un os, sans la deplacer : elle suivra l'os pendant les animations, sans se deformer."""
    arm = armature()
    if not arm or sur not in arm.data.bones:
        raise ValueError("os inconnu : %s" % sur)
    o = bpy.data.objects[objet] if isinstance(objet, str) else objet
    bpy.context.view_layer.update()
    mw = o.matrix_world.copy()
    o.parent = arm
    o.parent_type = "BONE"
    o.parent_bone = sur
    bpy.context.view_layer.update()
    o.matrix_world = mw
    return o


def _aplat(couleur, lueur=0.0, rugosite=0.85):
    nom = "Aplat %s%s" % (couleur.upper(), " lueur" if lueur else "")
    m = bpy.data.materials.get(nom)
    if not m:
        m = nouveau_materiau(nom, couleur, rugosite, 0.0, couleur if lueur else None, lueur)
    return m


def piece(nom, forme="boite", dims=(0.1, 0.1, 0.1), position=(0, 0, 0), rotation=(0, 0, 0), couleur="#808080", sur=None, biseau=0.012, lueur=0.0, cotes=16):
    """
    Une piece de figurine : forme simple (boite, cylindre, sphere, cone), dimensions en metres, CENTREE sur position,
    rotation en degres, une seule couleur (aplat mat, ou lumineuse avec lueur > 0), aretes adoucies par un biseau, et
    accrochee a l'os `sur` si on le donne. Pas de texture : la limite entre deux couleurs est le bord des pieces.
    """
    if forme == "boite":
        bpy.ops.mesh.primitive_cube_add(size=1)
    elif forme == "cylindre":
        bpy.ops.mesh.primitive_cylinder_add(vertices=cotes, radius=0.5, depth=1)
    elif forme == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=cotes, ring_count=max(6, cotes // 2), radius=0.5)
    elif forme == "cone":
        bpy.ops.mesh.primitive_cone_add(vertices=cotes, radius1=0.5, radius2=0, depth=1)
    else:
        raise ValueError("forme inconnue : %s (boite, cylindre, sphere, cone)" % forme)
    o = bpy.context.active_object
    o.name = nom
    o.scale = dims
    o.rotation_euler = [math.radians(a) for a in rotation]
    o.location = position
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if biseau and forme != "sphere":
        mod = o.modifiers.new("Biseau", "BEVEL")
        mod.width = biseau
        mod.segments = 2
        mod.limit_method = "ANGLE"
        bpy.ops.object.modifier_apply(modifier=mod.name)
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))
    except Exception:
        bpy.ops.object.shade_flat()
    o.data.materials.append(_aplat(couleur, lueur))
    if sur:
        fixer(o, sur)
    return o


def membre(nom, sur, epaisseur=0.1, forme="cylindre", couleur="#808080", largeur=None, debut=0.0, fin=1.0, biseau=0.012, lueur=0.0):
    """
    Une piece couchee le long d'un os, de son articulation de depart a celle d'arrivee : bras, avant-bras, cuisse,
    tibia. « debut » et « fin » (0 a 1) raccourcissent la piece aux deux bouts ; « largeur » (sinon = epaisseur) donne
    une section aplatie ; la piece est accrochee a l'os.
    """
    arm = armature()
    if not arm or sur not in arm.data.bones:
        raise ValueError("os inconnu : %s" % sur)
    b = arm.data.bones[sur]
    h, t = arm.matrix_world @ b.head_local, arm.matrix_world @ b.tail_local
    a, z = h.lerp(t, debut), h.lerp(t, fin)
    d = z - a
    o = piece(nom, forme, (largeur or epaisseur, epaisseur, max(d.length, 0.01)), (0, 0, 0), couleur=couleur, biseau=biseau, lueur=lueur)
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = d.to_track_quat("Z", "Y")
    o.location = (a + z) / 2
    fixer(o, sur)
    return o


def pieces():
    """Les pieces deja posees : nom, os, couleur, dimensions."""
    out = []
    for o in all_meshes():
        if o.get("calque"):
            continue
        mat = o.material_slots[0].material.name if o.material_slots and o.material_slots[0].material else None
        out.append({"piece": o.name, "sur": o.parent_bone if o.parent_type == "BONE" else None, "materiau": mat, "dimensions": [round(x, 3) for x in o.dimensions]})
    return out


# ---- Photos ----

def studio(name="Studio"):
    """
    Le studio photo (ADR-109) : trois lumieres douces qui suivent la camera (principale, debouchage, contre-jour), un fond en
    degrade que seule la camera voit, une ambiance neutre, la gestion des couleurs AgX. Chaque asset est photographie sous la
    meme lumiere, de chaque cote : un personnage sombre reste lisible, et deux assets se comparent. Rend light(azimut, sombre).
    """
    world = bpy.data.worlds.new(name)
    world.use_nodes = True
    nt = world.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputWorld")
    ambient = nt.nodes.new("ShaderNodeBackground")
    ambient.inputs[0].default_value = (0.5, 0.5, 0.52, 1)
    ambient.inputs[1].default_value = 0.45
    backdrop = nt.nodes.new("ShaderNodeBackground")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    path = nt.nodes.new("ShaderNodeLightPath")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(coord.outputs["Window"], sep.inputs[0])
    nt.links.new(sep.outputs["Y"], ramp.inputs[0])
    nt.links.new(ramp.outputs["Color"], backdrop.inputs[0])
    nt.links.new(path.outputs["Is Camera Ray"], mix.inputs[0])
    nt.links.new(ambient.outputs[0], mix.inputs[1])
    nt.links.new(backdrop.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs[0])
    scene.world = world

    def backdrop_tone(bottom, top):
        ramp.color_ramp.elements[0].color = bottom + (1,)
        ramp.color_ramp.elements[1].color = top + (1,)

    backdrop_tone((0.05, 0.055, 0.06), (0.30, 0.31, 0.33))
    rigs = []
    # (decalage depuis l'axe de la camera en degres, hauteur en degres sous l'horizon, force, couleur, douceur en degres)
    for nom, decal, tilt, force, couleur, douceur in (
        ("Principale", -40, 50, 3.2, (1.0, 0.96, 0.9), 12),
        ("Debouchage", 65, 68, 1.1, (0.85, 0.9, 1.0), 25),
        ("ContreJour", 165, 35, 3.0, (1.0, 1.0, 1.0), 8),
    ):
        lamp = bpy.data.objects.new(nom, bpy.data.lights.new(nom, "SUN"))
        lamp.data.energy = force
        lamp.data.color = couleur
        lamp.data.angle = math.radians(douceur)
        scene.collection.objects.link(lamp)
        rigs.append((lamp, decal, tilt))
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        try:
            scene.view_settings.view_transform = "Filmic"
        except TypeError:
            pass
    try:
        scene.eevee.taa_render_samples = 32
        scene.eevee.use_shadows = True
    except AttributeError:
        pass

    def light(azimut_deg, sombre=False):
        """Oriente les lumieres pour une camera placee a cet azimut (degres, autour du centre), fond sombre ou clair."""
        for lamp, decal, tilt in rigs:
            # Un soleil eclaire vers son -Z ; tourne de 0 autour de Z, il vient de -Y : +90 le fait venir du cote de la camera.
            lamp.rotation_euler = (math.radians(tilt), 0, math.radians(azimut_deg + 90 + decal))
        if sombre:
            backdrop_tone((0.01, 0.012, 0.015), (0.04, 0.045, 0.05))
        else:
            backdrop_tone((0.05, 0.055, 0.06), (0.30, 0.31, 0.33))

    return light


def photos(out_dir, prefix, size_hint=0):
    lo, hi = bounds()
    light = studio("Fond")
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
    scene.render.resolution_x = 1024
    scene.render.resolution_y = 1024
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
    # Une seule animation, a une image donnee (ou la pose de repos) : les pistes NLA, jouees ensemble, tordraient le modele
    # (voute, a demi en course) et l'emporteraient sur l'action meme muettes ; on les coupe le temps des photos (verifie en 4.5).
    arm = armature()
    animated = bool(arm and arm.animation_data and arm.animation_data.nla_tracks)
    idle = next((a for a in bpy.data.actions if "idle" in a.name.lower()), None) if animated else None
    was_nla = arm.animation_data.use_nla if animated else None

    def play(act, frame):
        arm.animation_data.use_nla = False
        arm.animation_data.action = act
        # Blender 4.4+ : une action ne joue que par son « slot » ; ceux de Tripo ne portent pas le nom de l'armature.
        if act and getattr(act, "slots", None) and len(act.slots):
            arm.animation_data.action_slot = act.slots[0]
        scene.frame_set(frame)

    def stand():
        if animated:
            play(idle, int(idle.frame_range[0]) if idle else 1)

    # Les photos principales et la vue de jeu montrent le modele debout : le debut de l'attente, sinon la pose de repos.
    stand()
    # Le devant regarde -Y : « face » est la camera placee en -Y.
    for name, deg in (("face", -90), ("trois-quarts", -45), ("profil", 0), ("dos", 90)):
        a = math.radians(deg)
        cam.location = center + Vector((math.cos(a) * radius, math.sin(a) * radius, radius * 0.45))
        light(deg)
        out.append(shoot("%s/%s-%s.png" % (out_dir, prefix, name)))
    # Le modele en mouvement (ADR-53) : une image au milieu de quelques animations, vue de trois-quarts, pour juger la
    # deformation (rien ne doit s'etirer, se detacher ni traverser le corps).
    if animated:
        seen, chosen = set(), []
        for pref in ("walk", "run", "hurt", "slash", "hit", "jump", "idle"):
            for a in bpy.data.actions:
                if a.name not in seen and pref in a.name.lower() and len(chosen) < 3:
                    seen.add(a.name)
                    chosen.append(a)
        a45 = math.radians(-45)
        light(-45)
        for act in chosen:
            play(act, int((act.frame_range[0] + act.frame_range[1]) / 2))
            # La camera suit le modele dans sa pose (une course peut le deplacer).
            plo, phi = bounds()
            target.location = (plo + phi) / 2
            cam.location = target.location + Vector((math.cos(a45) * radius, math.sin(a45) * radius, radius * 0.45))
            safe = re.sub(r"[^a-z0-9_]+", "-", act.name.lower()).strip("-")[:30]
            out.append(shoot("%s/%s-pose-%s.png" % (out_dir, prefix, safe)))
        target.location = center
        stand()
    # Vue de jeu : de haut et de loin, sur un sol sombre, comme la camera d'un jeu en 3/4 de dessus.
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, 0))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new("Sol")
    gm.use_nodes = True
    principled(gm).inputs["Base Color"].default_value = linear(hex_rgb("#30353C")) + [1]
    principled(gm).inputs["Roughness"].default_value = 1
    ground.data.materials.append(gm)
    far = max(max(hi - lo), 0.5) * 3.2
    cam.location = center + Vector((far * 0.35, -far * 0.6, far * 0.75))
    light(math.degrees(math.atan2(-0.6, 0.35)), sombre=True)
    out.append(shoot("%s/%s-vue-jeu.png" % (out_dir, prefix)))
    # Le sol ne doit pas rester dans la scene : il fausserait les mesures et les bandes d'animation.
    bpy.data.objects.remove(ground, do_unlink=True)
    if animated:
        arm.animation_data.action = None
        arm.animation_data.use_nla = was_nla
        scene.frame_set(1)
    return out


# ---- Animations (ADR-56) : des ciseaux, pas de l'animation ----

def _action(nom):
    a = bpy.data.actions.get(nom) or next((a for a in bpy.data.actions if a.name.lower() == str(nom).lower()), None)
    if not a:
        raise ValueError("animation inconnue : %s (il y a %s)" % (nom, ", ".join(a.name for a in bpy.data.actions)))
    return a


def _restrip(act):
    """Refait la piste NLA de cette action (sa bande suit la nouvelle longueur)."""
    for arm in [o for o in scene.objects if o.type == "ARMATURE" and o.animation_data]:
        tracks = arm.animation_data.nla_tracks
        for t in [t for t in tracks if any(s.action == act for s in t.strips)]:
            tracks.remove(t)
        t = tracks.new()
        t.name = act.name
        t.strips.new(act.name, 0, act)


def couper(nom, debut_s, fin_s):
    """
    Garde seulement le morceau entre debut_s et fin_s (secondes) de cette animation, qui recommence alors a 0 : un seul
    coup d'epee au lieu d'un enchainement, le debut d'un coup recu sans la chute. Les poses aux bords sont conservees.
    """
    act = _action(nom)
    fps = scene.render.fps
    f0, f1 = debut_s * fps, fin_s * fps
    if f1 <= f0:
        raise ValueError("fin_s doit depasser debut_s")
    act.use_frame_range = False
    for fc in act.fcurves:
        for f in (f0, f1):
            fc.keyframe_points.insert(f, fc.evaluate(f), options={"FAST"})
        for i in reversed(range(len(fc.keyframe_points))):
            x = fc.keyframe_points[i].co.x
            if x < f0 - 1e-3 or x > f1 + 1e-3:
                fc.keyframe_points.remove(fc.keyframe_points[i], fast=True)
        for kp in fc.keyframe_points:
            kp.co.x -= f0
            kp.handle_left.x -= f0
            kp.handle_right.x -= f0
        fc.update()
    _restrip(act)
    return animations()


def vitesse(nom, facteur):
    """Joue cette animation facteur fois plus vite (0.8 : plus lente et plus lourde, 1.5 : plus vive)."""
    act = _action(nom)
    if facteur <= 0:
        raise ValueError("facteur > 0")
    act.use_frame_range = False
    for fc in act.fcurves:
        for kp in fc.keyframe_points:
            kp.co.x /= facteur
            kp.handle_left.x /= facteur
            kp.handle_right.x /= facteur
        fc.update()
    _restrip(act)
    return animations()


def bandes(out_dir, prefix, n=6):
    """
    Une bande de n images par animation (du debut a la fin, de trois-quarts), pour juger le mouvement : son sens, sa
    duree, son allure. Fichiers <prefix>-anim-<nom>.png.
    """
    import numpy as np
    arm = armature()
    if not arm or not arm.animation_data or not bpy.data.actions:
        return []
    lo, hi = bounds()
    R = max(max(hi - lo), 0.5) * 1.9
    world = bpy.data.worlds.new("FondBande")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.32, 0.33, 0.35, 1)
    scene.world = world
    sun = bpy.data.objects.new("SoleilBande", bpy.data.lights.new("SoleilBande", "SUN"))
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), 0, math.radians(35))
    scene.collection.objects.link(sun)
    cam = bpy.data.objects.new("CameraBande", bpy.data.cameras.new("CameraBande"))
    cam.data.lens = 40
    scene.collection.objects.link(cam)
    scene.camera = cam
    w, h = 320, 400
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.image_settings.file_format = "PNG"
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.color_type = "TEXTURE"
    was_nla = arm.animation_data.use_nla
    arm.animation_data.use_nla = False
    a45 = math.radians(-45)
    out = []
    for act in bpy.data.actions:
        arm.animation_data.action = act
        if getattr(act, "slots", None) and len(act.slots):
            arm.animation_data.action_slot = act.slots[0]
        f0, f1 = act.frame_range
        safe = re.sub(r"[^a-z0-9_]+", "-", act.name.lower()).strip("-")[:30]
        frames = []
        for k in range(n):
            scene.frame_set(int(round(f0 + (f1 - f0) * k / max(n - 1, 1))))
            # La camera suit le squelette dans sa pose (la boite du maillage, elle, ne suit pas la deformation).
            pts = [arm.matrix_world @ pb.head for pb in arm.pose.bones]
            c = (Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts))) + Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))) / 2
            cam.location = c + Vector((math.cos(a45) * R, math.sin(a45) * R, R * 0.35))
            cam.rotation_euler = (c - cam.location).to_track_quat("-Z", "Y").to_euler()
            path = "%s/%s-anim-%s-%d.png" % (out_dir, prefix, safe, k)
            scene.render.filepath = path
            bpy.ops.render.render(write_still=True)
            frames.append(path)
        sheet = np.zeros((h, w * n, 4), dtype=np.float32)
        for k, path in enumerate(frames):
            im = bpy.data.images.load(path)
            a = np.empty(w * h * 4, dtype=np.float32)
            im.pixels.foreach_get(a)
            sheet[:, k * w:(k + 1) * w, :] = a.reshape(h, w, 4)
            bpy.data.images.remove(im)
            os.remove(path)
        img = bpy.data.images.new("bande-" + safe, w * n, h)
        img.pixels.foreach_set(sheet.reshape(-1))
        img.filepath_raw = "%s/%s-anim-%s.png" % (out_dir, prefix, safe)
        img.file_format = "PNG"
        img.save()
        out.append(img.filepath_raw)
    arm.animation_data.action = None
    arm.animation_data.use_nla = was_nla
    scene.frame_set(1)
    return out


# ---- Modes ----

SAFE_MODULES ={"bpy", "bmesh", "mathutils", "math", "random", "numpy", "colorsys", "itertools", "functools", "collections", "re", "json"}
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
    for k in ("meshes", "triangles", "bounds", "materials", "summary", "normalize", "budget", "tourner", "matiere", "aplat", "nouveau_materiau", "quantifier", "couleurs", "teinter", "lueur", "animations", "couper", "vitesse", "boite", "cylindre", "base_image", "squelette", "zones", "fixer", "piece", "membre", "pieces", "calque", "armature", "facettes", "aplats_facettes", "nettoyer_texture"):
        env[k] = globals()[k]
    env["mesures"] = summary
    env["controle"] = controle
    env["reparer"] = reparer
    env["palette"] = job.get("palette", [])
    # Les pieces se posent et s'accrochent en pose de repos : c'est elle que les animations deforment ensuite.
    arm = armature()
    if arm:
        arm.data.pose_position = "REST"
        bpy.context.view_layer.update()
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            exec(compile(code, "atelier", "exec"), env)
    except Exception:
        return {"ok": False, "sortie": buf.getvalue()[-4000:], "erreur": traceback.format_exc(limit=4)[-3000:]}
    finally:
        if arm and arm.name in bpy.data.objects:
            arm.data.pose_position = "POSE"
    return {"ok": True, "sortie": buf.getvalue()[-6000:], "erreur": None}


def name_new(actions, name):
    for a in actions:
        a.name = name if len(actions) == 1 else "%s_%s" % (name, a.name)
        a.use_fake_user = True


def import_extra(path, name):
    """Importe un fichier d'animation de Tripo (meme squelette) : on garde l'action sous ce nom, on jette le reste."""
    objs, acts = set(bpy.data.objects), set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=path)
    name_new([a for a in bpy.data.actions if a not in acts], name)
    for o in [o for o in bpy.data.objects if o not in objs]:
        bpy.data.objects.remove(o, do_unlink=True)


def import_raw():
    bpy.ops.import_scene.gltf(filepath=job["input"])
    names = job.get("animations") or []
    if names:
        name_new(list(bpy.data.actions), names[0])
    # Animations suivantes (meme squelette) : on garde l'action, on jette le reste du fichier.
    for i, extra in enumerate(job.get("extras") or []):
        import_extra(extra, names[i + 1] if i + 1 < len(names) else "anim_%d" % (i + 2))
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
        if job.get("facettes"):
            facettes(True)
            nettoyer_texture()
    bpy.ops.wm.save_as_mainfile(filepath=job["blend"])
    done(summary())
elif mode == "python":
    # Garde au pas (ADR-116) : la scene d'avant ce code est gardee, sa sante mesuree avant et apres ; le hub decide.
    import shutil
    shutil.copyfile(job["blend"], os.path.join(os.path.dirname(job["blend"]), "scene-avant-pas.blend"))
    avant = sante()
    r = run_code(job["code"])
    if r["ok"]:
        r["sante"] = {"avant": avant, "apres": sante()}
        bpy.ops.wm.save_as_mainfile(filepath=job["blend"])
    done(r)
elif mode == "restaurer":
    # La scene revient a une copie gardee (ADR-116) : celle d'avant un code casse, ou celle de la meilleure passe.
    import shutil
    shutil.copyfile(job["source"], job["blend"])
    done({"ok": True})
elif mode == "photos":
    done({"photos": photos(job["out_dir"], job["prefix"]), "mesures": summary()})
elif mode == "animations":
    # Des animations ajoutees ou remplacees sur le squelette deja paye (ADR-56) ; celles hors de « garder » s'en vont.
    arm = armature()
    if not arm:
        raise SystemExit("aucun squelette dans la scene")
    for path, name in zip(job["extras"], job["animations"]):
        old = bpy.data.actions.get(name)
        if old:
            for t in [t for t in arm.animation_data.nla_tracks if any(s.action == old for s in t.strips)]:
                arm.animation_data.nla_tracks.remove(t)
            bpy.data.actions.remove(old)
        import_extra(path, name)
    keep = set(job.get("garder") or [])
    for a in list(bpy.data.actions):
        if keep and a.name not in keep:
            for t in [t for t in arm.animation_data.nla_tracks if any(s.action == a for s in t.strips)]:
                arm.animation_data.nla_tracks.remove(t)
            bpy.data.actions.remove(a)
    arm.animation_data_create()
    arm.animation_data.action = None
    for a in bpy.data.actions:
        if not any(s.action == a for t in arm.animation_data.nla_tracks for s in t.strips):
            track = arm.animation_data.nla_tracks.new()
            track.name = a.name
            track.strips.new(a.name, 0, a)
    bpy.ops.wm.save_as_mainfile(filepath=job["blend"])
    done(summary())
elif mode == "export":
    # Figurine : le calque ne part pas dans le jeu, seules les pieces y vont (avec le squelette et les animations).
    if any(not o.get("calque") for o in all_meshes()):
        for o in [o for o in all_meshes() if o.get("calque")]:
            bpy.data.objects.remove(o, do_unlink=True)
    before = budget(int(job.get("max_tris") or 0))
    normalize(float(job.get("size") or 0))
    shrink_textures(int(job.get("max_texture") or 0))
    # La reduction au budget recree des faces : le choix de l'atelier (ou le style de la fiche) est reapplique.
    if scene.get("facettes") is not None:
        facettes(bool(scene["facettes"]))
    elif job.get("facettes"):
        facettes(True)
    has_anim = any(o.type == "ARMATURE" and o.animation_data and o.animation_data.nla_tracks for o in scene.objects)
    bpy.ops.export_scene.gltf(filepath=job["output"], export_format="GLB", export_yup=True, export_animations=True, export_animation_mode="NLA_TRACKS" if has_anim else "ACTIONS", export_apply=False)
    s = summary()
    lo, hi = bounds()
    renders = photos(job["out_dir"], job["prefix"])
    strips = bandes(job["out_dir"], job["prefix"])
    done({"renders": renders, "bandes": strips, "tris_before": before, "tris_after": s["triangles"], "dims": list(hi - lo), "animations": [a.name for a in bpy.data.actions], "durees": animations(), "materiaux": s["materiaux"], "controle": s["controle"]})
