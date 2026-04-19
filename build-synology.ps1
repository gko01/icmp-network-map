# build-synology.ps1
# Builds a multi-arch Docker image (linux/amd64 + linux/arm64) and either:
#   - pushes it to Docker Hub, OR
#   - exports it as a .tar file you can scp to your Synology NAS
#
# Usage:
#   .\build-synology.ps1                        # export tar only (no registry)
#   .\build-synology.ps1 -DockerHubUser myname  # build + push to Docker Hub

param(
    [string]$DockerHubUser = "",
    [string]$Tag = "latest",
    [string]$ImageName = "icmp-network-map"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot

# ── 1. Ensure buildx builder with multi-arch support exists ─────────────────
$BuilderName = "multiarch-builder"
$existing = docker buildx ls 2>$null | Select-String $BuilderName
if (-not $existing) {
    Write-Host "Creating buildx builder '$BuilderName'..." -ForegroundColor Cyan
    docker buildx create --name $BuilderName --driver docker-container --bootstrap
}
docker buildx use $BuilderName

# ── 2. Determine image reference ─────────────────────────────────────────────
if ($DockerHubUser -ne "") {
    $FullImage = "${DockerHubUser}/${ImageName}:${Tag}"
    $Push = $true
} else {
    $FullImage = "${ImageName}:${Tag}"
    $Push = $false
}

Write-Host ""
Write-Host "Image   : $FullImage" -ForegroundColor White
Write-Host "Push    : $Push" -ForegroundColor White
Write-Host "Platform: linux/amd64,linux/arm64" -ForegroundColor White
Write-Host ""

# ── 3. Build ──────────────────────────────────────────────────────────────────
if ($Push) {
    Write-Host "Building and pushing to Docker Hub..." -ForegroundColor Cyan
    docker buildx build `
        --platform linux/amd64,linux/arm64 `
        --tag $FullImage `
        --push `
        $ProjectRoot

    Write-Host ""
    Write-Host "Done. On your Synology NAS, update docker-compose.synology.yml:" -ForegroundColor Green
    Write-Host "  image: $FullImage" -ForegroundColor Yellow
    Write-Host "Then run: docker compose up -d" -ForegroundColor Yellow
} else {
    # Export mode: build for each arch and save a single tar the NAS can load
    # (docker buildx can only --load single-arch; we export amd64 by default
    #  unless the NAS is ARM64 — see the -Platform parameter note below)
    $Platform = "linux/amd64"   # change to linux/arm64 for ARM-based Synology models

    $TarFile = Join-Path $ProjectRoot "${ImageName}.tar"

    Write-Host "Building for $Platform and exporting to ${ImageName}.tar ..." -ForegroundColor Cyan
    docker buildx build `
        --platform $Platform `
        --tag "${ImageName}:${Tag}" `
        --output "type=docker,dest=$TarFile" `
        $ProjectRoot

    Write-Host ""
    Write-Host "Done. Transfer the image to your NAS and load it:" -ForegroundColor Green
    Write-Host "  scp $TarFile  your-nas-user@NAS_IP:/volume1/docker/icmp-network-map/" -ForegroundColor Yellow
    Write-Host "  ssh your-nas-user@NAS_IP 'docker load -i /volume1/docker/icmp-network-map/${ImageName}.tar'" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Then start the container:" -ForegroundColor Green
    Write-Host "  ssh your-nas-user@NAS_IP 'cd /volume1/docker/icmp-network-map && docker compose up -d'" -ForegroundColor Yellow
}
