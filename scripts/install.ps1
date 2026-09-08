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

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Stop-WithNodeGuidance "OriginRouter requires Node.js 22 or later."
}

$nodeVersionText = (& node --version).Trim()
$nodeMajorText = $nodeVersionText.TrimStart("v").Split(".")[0]
$nodeMajor = 0
if (-not [int]::TryParse($nodeMajorText, [ref]$nodeMajor) -or $nodeMajor -lt $MinimumNodeMajor) {
    Stop-WithNodeGuidance "OriginRouter requires Node.js 22 or later; detected $nodeVersionText."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Stop-WithNodeGuidance "npm is required but is not available."
}
& npm --version *> $null
if ($LASTEXITCODE -ne 0) {
    Stop-WithNodeGuidance "npm is installed but is not working."
}

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
