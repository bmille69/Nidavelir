// La carte des types (ADR-65) : les noms des types, méthodes, champs et propriétés des assemblies générées par le
// chargeur de mods, en texte. Seulement des noms (métadonnées), jamais le code : l'agent y cherche où brancher ses patchs.
// Usage : Typemap <dossier des assemblies> <fichier de sortie>
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text.RegularExpressions;

static class Typemap
{
    static readonly Regex Skip = new Regex(@"^(System|Microsoft|Mono|netstandard|mscorlib|Il2Cppmscorlib|Il2CppSystem|Il2CppMono|Unity\.|UnityEngine|Newtonsoft|Il2CppNewtonsoft|Il2CppInterop|Iced|Steamworks|Il2CppSteamworks|Il2CppRewired|Il2CppDOTween|Il2CppSirenix|Il2CppTMPro|Il2CppUniTask|Il2CppCinemachine|Il2CppFacepunch)", RegexOptions.IgnoreCase);

    static int Main(string[] args)
    {
        if (args.Length != 2) { Console.Error.WriteLine("Usage : Typemap <dossier> <sortie>"); return 2; }
        var lines = new List<string>();
        int types = 0;
        foreach (var file in Directory.GetFiles(args[0], "*.dll").OrderBy(f => f))
        {
            var name = Path.GetFileNameWithoutExtension(file);
            if (Skip.IsMatch(name)) continue;
            try
            {
                using var stream = File.OpenRead(file);
                using var pe = new PEReader(stream);
                if (!pe.HasMetadata) continue;
                var md = pe.GetMetadataReader();
                lines.Add($"# {name}");
                foreach (var h in md.TypeDefinitions)
                {
                    var t = md.GetTypeDefinition(h);
                    var tn = md.GetString(t.Name);
                    if (tn.StartsWith("<") || tn.Contains("__") || tn == "<Module>") continue;
                    var ns = md.GetString(t.Namespace);
                    var full = string.IsNullOrEmpty(ns) ? tn : $"{ns}.{tn}";
                    if (!t.GetDeclaringType().IsNil) full = $"{md.GetString(md.GetTypeDefinition(t.GetDeclaringType()).Name)}+{tn}";
                    var methods = t.GetMethods().Select(m => md.GetString(md.GetMethodDefinition(m).Name))
                        .Where(n => !n.StartsWith("<") && !n.StartsWith("get_") && !n.StartsWith("set_") && !n.StartsWith("NativeMethodInfoPtr") && n != ".cctor")
                        .Distinct().Take(80).ToList();
                    var props = t.GetProperties().Select(p => md.GetString(md.GetPropertyDefinition(p).Name)).Where(n => !n.StartsWith("<")).Distinct().Take(60).ToList();
                    var fields = t.GetFields().Select(f => md.GetString(md.GetFieldDefinition(f).Name))
                        .Where(n => !n.StartsWith("<") && !n.StartsWith("NativeFieldInfoPtr") && !n.StartsWith("NativeMethodInfoPtr")).Distinct().Take(40).ToList();
                    lines.Add($"{full}");
                    if (methods.Count > 0) lines.Add($"  méthodes : {string.Join(", ", methods)}");
                    if (props.Count > 0) lines.Add($"  propriétés : {string.Join(", ", props)}");
                    if (fields.Count > 0) lines.Add($"  champs : {string.Join(", ", fields)}");
                    types++;
                }
            }
            catch (Exception e)
            {
                lines.Add($"# {name} : illisible ({e.Message})");
            }
        }
        File.WriteAllLines(args[1], lines);
        Console.WriteLine($"{types} types");
        return 0;
    }
}
