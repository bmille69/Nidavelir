/** Page de connexion d'un téléphone : le code à 6 chiffres affiché sur le PC (ADR-30). */
export const PAIRING_PAGE = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#0a0c12" />
<title>Connexion — Game Studio Hub</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0c12; color: #ebeaf3; font: 16px/1.5 system-ui, sans-serif; padding: 16px; box-sizing: border-box; }
  main { width: 100%; max-width: 380px; background: #131722; border: 1px solid rgba(255,255,255,.08); border-radius: 18px; padding: 24px; }
  h1 { font-size: 1.3rem; margin: 0 0 .3rem; }
  p { color: #8d92a8; margin: 0 0 1rem; }
  input { box-sizing: border-box; width: 100%; font: inherit; color: inherit; background: #1a1f2d; border: 1px solid rgba(255,255,255,.14); border-radius: 12px; padding: .75rem; margin-bottom: .75rem; }
  #code { font-size: 2rem; letter-spacing: .5em; text-align: center; }
  button { width: 100%; font: inherit; font-weight: 700; border: 0; border-radius: 12px; padding: .8rem; background: linear-gradient(135deg, #a593ff, #6f8dff); color: #0b0d16; }
  .err { color: #ff7a85; min-height: 1.5em; margin: .5rem 0 0; }
</style>
</head>
<body>
<main>
  <h1>Connecter ce téléphone</h1>
  <p>Sur le PC, ouvrez « Téléphone » dans le hub et cliquez « Afficher un code ». Il est valable 5 minutes.</p>
  <form id="f">
    <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" required />
    <input id="name" maxlength="60" placeholder="Nom de cet appareil (ex. Mon téléphone)" />
    <button>Se connecter</button>
    <p class="err" id="err"></p>
  </form>
</main>
<script>
  document.getElementById("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = document.getElementById("err");
    err.textContent = "";
    const res = await fetch("/login/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: document.getElementById("code").value.trim(), name: document.getElementById("name").value.trim() || "Téléphone" }),
    });
    if (res.ok) location.href = "/";
    else err.textContent = (await res.json().catch(() => ({}))).error || "Connexion refusée";
  });
</script>
</body>
</html>`;
