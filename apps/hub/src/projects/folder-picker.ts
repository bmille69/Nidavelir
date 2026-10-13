import { execFile } from "node:child_process";

export interface FolderPicker {
  /** Ouvre la boîte de dialogue ; renvoie le dossier choisi, ou null si annulé. */
  pick(initialDir: string): Promise<string | null>;
}

/**
 * Boîte de dialogue Windows native, ouverte par le backend local, car un navigateur
 * ne transmet pas le chemin absolu d'un dossier (ADR-12, hypothèse H6).
 */
export class WindowsFolderPicker implements FolderPicker {
  pick(initialDir: string): Promise<string | null> {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = 'CenterScreen' }
$owner.Show(); $owner.Activate()
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Game Studio Hub : choisissez le dossier du jeu à importer'
$d.ShowNewFolderButton = $false
$d.SelectedPath = ${psString(initialDir)}
$r = $d.ShowDialog($owner)
$owner.Close()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded],
        { windowsHide: false, timeout: 10 * 60_000, encoding: "utf8" },
        (err, stdout) => {
          if (err) reject(new Error(`Boîte de dialogue indisponible : ${err.message}`));
          else resolve(stdout.trim() || null);
        },
      );
    });
  }
}

function psString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
