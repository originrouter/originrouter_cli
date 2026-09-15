param(
    [string]$Release = $(if ($env:ORIGINROUTER_RELEASE) { $env:ORIGINROUTER_RELEASE } else { "latest" }),
    [switch]$Yes,
    [switch]$NoProxy,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$PackageName = "@originrouter/cli"
$MinimumNodeMajor = 22

if ($Release -notmatch '^(latest|\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$') {
    Write-Error "Invalid release: $Release. Expected latest or a semantic version."
    exit 1
}

function Stop-WithNodeGuidance([string]$Message) {
    Write-Error "$Message`nInstall Node.js from https://nodejs.org/en/download and run this command again. The Node.js installer includes npm."
    exit 1
}

function Test-NodeUsable {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) { return $false }
    $versionText = (& node --version).Trim()
    $majorText = $versionText.TrimStart("v").Split(".")[0]
    $major = 0
    if (-not [int]::TryParse($majorText, [ref]$major) -or $major -lt $MinimumNodeMajor) { return $false }
    if ($null -eq (Get-Command npm -ErrorAction SilentlyContinue)) { return $false }
    & npm --version *> $null
    return ($LASTEXITCODE -eq 0)
}

function Update-SessionPathFromRegistry {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

function Test-Elevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Install-NodeViaWinget {
    if ($null -eq (Get-Command winget -ErrorAction SilentlyContinue)) { return $false }
    Write-Output "==> Installing Node.js 22 LTS via winget (Windows may show an elevation prompt)"
    & winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { return $false }
    Update-SessionPathFromRegistry
    return $true
}

function Install-NodeViaUserZip {
    Write-Output "==> Installing a user-level Node.js 22 runtime under $env:LOCALAPPDATA (no elevation required)"
    $entry = $null
    try {
        $versions = Invoke-RestMethod "https://nodejs.org/dist/index.json" -TimeoutSec 30
        $entry = $versions | Where-Object { $_.version -like "v$MinimumNodeMajor.*" } | Select-Object -First 1
    } catch {
        return $false
    }
    if ($null -eq $entry) { return $false }
    $version = $entry.version.TrimStart("v")
    $zipName = "node-$($entry.version)-win-x64.zip"
    $zipUrl = "https://nodejs.org/dist/v$version/$zipName"
    $installRoot = Join-Path $env:LOCALAPPDATA "OriginRouter"
    $binDir = Join-Path $installRoot "node-$($entry.version)-win-x64"
    try {
        if (-not (Test-Path -LiteralPath (Join-Path $binDir "node.exe"))) {
            $zipPath = Join-Path $env:TEMP $zipName
            Invoke-WebRequest $zipUrl -OutFile $zipPath -TimeoutSec 600
            Expand-Archive $zipPath -DestinationPath $installRoot -Force
            Remove-Item $zipPath -Force
        }
    } catch {
        return $false
    }
    if (-not (Test-Path -LiteralPath (Join-Path $binDir "node.exe"))) { return $false }
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (($null -eq $userPath) -or (-not $userPath.Split(";").Contains($binDir))) {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$binDir", "User")
    }
    $env:Path = "$binDir;$env:Path"
    return $true
}

if (-not (Test-NodeUsable)) {
    Write-Output "==> Node.js $MinimumNodeMajor or later with npm was not found."
    $installed = $false
    if (Test-Elevated) {
        $installed = Install-NodeViaWinget
        if (-not $installed) { $installed = Install-NodeViaUserZip }
    } else {
        $installed = Install-NodeViaUserZip
        if (-not $installed) { $installed = Install-NodeViaWinget }
    }
    if (-not $installed -or -not (Test-NodeUsable)) {
        Stop-WithNodeGuidance "Automatic Node.js installation failed."
    }
}

$nodeVersionText = (& node --version).Trim()

$mutex = New-Object System.Threading.Mutex($false, "Local\OriginRouterInstaller")
if (-not $mutex.WaitOne(0)) {
    Write-Error "Another OriginRouter installation is running."
    exit 1
}

try {
    $existing = Get-Command originrouter -ErrorAction SilentlyContinue
    $npmPrefix = (& npm prefix --global).Trim()
    $expectedCommand = Join-Path $npmPrefix "originrouter.cmd"
    $globalPackage = Join-Path ((& npm root --global).Trim()) "@originrouter\cli"
    if (Test-Path -LiteralPath $globalPackage) {
        $packageItem = Get-Item -LiteralPath $globalPackage -Force
        if ($null -ne $packageItem.LinkType) {
            throw "A repository-linked OriginRouter installation was found at $globalPackage. Run npm unlink --global @originrouter/cli before using the official installer."
        }
    }
    if ($null -ne $existing -and -not $existing.Source.Equals($expectedCommand, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "An OriginRouter command outside the active npm global directory was found at $($existing.Source). Resolve the PATH or installation conflict before continuing."
    }
    if ($null -ne $existing) {
        & npm list --global --depth=0 $PackageName *> $null
        if ($LASTEXITCODE -ne 0) {
            throw "An OriginRouter command managed outside the global npm installation was found at $($existing.Source). Remove the conflicting repository link or installation before continuing."
        }
    }

    $packageSpec = "$PackageName@$Release"
    Write-Output "==> Node.js $nodeVersionText"
    Write-Output "==> Installing $packageSpec from npm"

    $setupArgs = @()
    if ($Yes) { $setupArgs += "--yes" }
    if ($NoProxy) { $setupArgs += "--no-proxy" }
    if ($DryRun) { $setupArgs += "--dry-run" }

    if ($DryRun) {
        Write-Output "Would run: npm install --global $packageSpec"
        if ($null -ne $existing) {
            & $existing.Source setup @setupArgs
        } else {
            Write-Output "Would run: originrouter setup --dry-run"
        }
        exit 0
    }

    & npm install --global $packageSpec
    if ($LASTEXITCODE -ne 0) {
        throw "OriginRouter CLI installation failed. Verify that the npm global directory is writable and that the npm registry is reachable. The installer does not change npm permissions automatically."
    }

    $cli = Get-Command originrouter -ErrorAction SilentlyContinue
    if ($null -eq $cli) {
        $candidate = Join-Path $npmPrefix "originrouter.cmd"
        if (Test-Path -LiteralPath $candidate) {
            $cliPath = $candidate
        } else {
            throw "OriginRouter was installed, but the command could not be found on PATH. Open a new terminal and run this installer again."
        }
    } else {
        $cliPath = $cli.Source
    }

    & $cliPath --version
    if ($LASTEXITCODE -ne 0) { throw "The installed OriginRouter command failed verification." }
    Write-Output "==> Preparing the OriginRouter runtime"
    & $cliPath setup @setupArgs
    if ($LASTEXITCODE -ne 0) { throw "OriginRouter setup did not complete successfully. Run the same installer command again to resume." }
    Write-Output "==> OriginRouter installation complete"
}
finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
