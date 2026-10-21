param(
  [Parameter(Mandatory = $true)][string]$ResultPath,
  [string]$InitialPath = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms

try {
  [System.Windows.Forms.Application]::EnableVisualStyles()
} catch {
  # Visual styles are optional for this native dialog.
}

$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select the folder that contains your photos'
$dialog.ShowNewFolderButton = $false

if ($InitialPath -and (Test-Path -LiteralPath $InitialPath -PathType Container)) {
  try {
    $dialog.SelectedPath = (Resolve-Path -LiteralPath $InitialPath).Path
  } catch {
    # Use the default starting location when the saved folder is unavailable.
  }
}

$result = $dialog.ShowDialog()

if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
  exit 2
}

$selectedPath = $dialog.SelectedPath

if ([string]::IsNullOrWhiteSpace($selectedPath)) {
  exit 2
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ResultPath, $selectedPath, $utf8)
exit 0
