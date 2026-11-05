[CmdletBinding()]
param(
    [string]$BuildPython = 'python',
    [string]$PythonBundleDir,
    [string]$SpeechModelDir
)

$ErrorActionPreference = 'Stop'
$engine = Join-Path $PSScriptRoot 'build\desktop-engine'
$runtime = Join-Path $engine 'runtime'
$packages = Join-Path $runtime 'Lib\site-packages'
New-Item -ItemType Directory -Path $runtime, $packages -Force | Out-Null

if ($PythonBundleDir) {
    Get-ChildItem -LiteralPath $PythonBundleDir -File |
        Copy-Item -Destination $runtime -Force
} elseif (-not (Test-Path -LiteralPath (Join-Path $runtime 'python.exe'))) {
    $archive = Join-Path $engine 'python-3.12.10-embed-amd64.zip'
    Invoke-WebRequest 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip' -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $runtime -Force
}
@('python312.zip', '.', 'Lib\site-packages', 'import site') |
    Set-Content -Encoding ascii -LiteralPath (Join-Path $runtime 'python312._pth')

& $BuildPython -c "import struct,sys; sys.exit(0 if sys.version_info[:2] == (3,12) and struct.calcsize('P') == 8 else 1)"
if ($LASTEXITCODE) { throw 'Python 3.12 x64 is required to build the desktop runtime.' }
& $BuildPython -m pip install --upgrade --ignore-installed --target $packages -r (Join-Path $PSScriptRoot 'backend\requirements-desktop.txt')
if ($LASTEXITCODE) { throw 'Desktop runtime dependencies could not be installed.' }

if ($SpeechModelDir) {
    $model = Join-Path $engine 'models\speech-base'
    New-Item -ItemType Directory -Path $model -Force | Out-Null
    foreach ($name in @('config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt')) {
        $from = (Get-Item -LiteralPath (Join-Path $SpeechModelDir $name)).ResolveLinkTarget($true)
        if ($null -eq $from) { $from = Get-Item -LiteralPath (Join-Path $SpeechModelDir $name) }
        Copy-Item -LiteralPath $from.FullName -Destination (Join-Path $model $name) -Force
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'third_party\whisper-LICENSE.txt') -Destination (Join-Path $model 'LICENSE.txt') -Force
}

Push-Location $PSScriptRoot
try {
    & (Join-Path $runtime 'python.exe') -c "import sys; sys.path.insert(0,'.'); import av, faster_whisper, rapidocr_onnxruntime, backend.desktop_app; print('Desktop engine ready')"
    if ($LASTEXITCODE) { throw 'The staged desktop runtime failed to import.' }
} finally {
    Pop-Location
}
Write-Output $engine
