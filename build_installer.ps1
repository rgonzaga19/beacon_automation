param(
    [string]$InnoCompiler = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
)

$ErrorActionPreference = "Stop"

python -m pip install -r requirements.txt
python -m pip install -r requirements-build.txt
python -m PyInstaller --clean Beabots.spec

if (-not (Test-Path -LiteralPath $InnoCompiler)) {
    throw "Inno Setup compiler not found: $InnoCompiler"
}

& $InnoCompiler "BeaconInstaller.iss"
