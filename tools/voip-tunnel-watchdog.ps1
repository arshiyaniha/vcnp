<#
.SYNOPSIS
  Reverse SSH tunnel watchdog for the real PSTN تلفنخانه webhook.

.DESCRIPTION
  Keeps a reverse SSH tunnel alive from THIS machine (running the VCNP live
  server) to the PBX server, so the PBX's webhook script can reach our
  live server at 127.0.0.1:<RemotePort> on ITS OWN loopback — no public IP,
  no port forwarding, no third-party relay/coordination service (deliberate:
  a foreign SaaS dependency is a real liability given intermittent
  international connectivity). Just plain OpenSSH, already present on both
  a normal Linux server and Windows 10/11.

  Security model:
    - The PBX-side account this connects as should be a DEDICATED,
      restricted user (see docs/RAHNAMA-FA.md's تلفنخانه section) whose
      authorized_keys entry only permits this specific reverse forward
      (permitopen="127.0.0.1:<LocalPort>") and nothing else (no shell, no
      exec, no other forwards).
    - `-R 127.0.0.1:<RemotePort>:127.0.0.1:<LocalPort>` binds the remote
      listening socket to the PBX server's OWN loopback only — nothing on
      the wider internet can reach it, only processes running on that same
      server (exactly the webhook script).
    - If the tunnel drops (network blip, reboot, international connectivity
      outage), this loop reconnects on its own — no manual intervention.

.PARAMETER RemoteUser
  The restricted SSH user on the PBX server (e.g. vcnp-tunnel).

.PARAMETER RemoteHost
  The PBX server's address (e.g. srv1 or its IP).

.PARAMETER RemotePort
  Port opened on the PBX server's own loopback, forwarding to this
  machine's live server. Default 18099.

.PARAMETER LocalPort
  This machine's live server port. Default 7788 (VCNP_OFFICE_PORT default).

.PARAMETER KeyPath
  Private key for the dedicated tunnel identity. Default
  %USERPROFILE%\.ssh\vcnp_voip_tunnel (never reuse a key used for anything
  else — this one's sole purpose is this tunnel, so it can be revoked
  independently without touching any other access).

.EXAMPLE
  .\tools\voip-tunnel-watchdog.ps1 -RemoteUser vcnp-tunnel -RemoteHost 109.122.252.251
#>
param(
    [Parameter(Mandatory = $true)][string]$RemoteUser,
    [Parameter(Mandatory = $true)][string]$RemoteHost,
    [int]$RemotePort = 18099,
    [int]$LocalPort = 7788,
    [string]$KeyPath = "$env:USERPROFILE\.ssh\vcnp_voip_tunnel"
)

if (-not (Test-Path -LiteralPath $KeyPath)) {
    Write-Error "Tunnel private key not found: $KeyPath — generate it first: ssh-keygen -t ed25519 -f `"$KeyPath`" -N `"`""
    exit 1
}

Write-Output "$(Get-Date -Format o) [voip-tunnel] starting watchdog: $RemoteUser@$RemoteHost (their 127.0.0.1:$RemotePort -> our 127.0.0.1:$LocalPort)"

while ($true) {
    Write-Output "$(Get-Date -Format o) [voip-tunnel] connecting..."
    & ssh -N `
        -o ExitOnForwardFailure=yes `
        -o ServerAliveInterval=20 `
        -o ServerAliveCountMax=3 `
        -o StrictHostKeyChecking=accept-new `
        -o BatchMode=yes `
        -i $KeyPath `
        -R "127.0.0.1:${RemotePort}:127.0.0.1:${LocalPort}" `
        "$RemoteUser@$RemoteHost"
    Write-Output "$(Get-Date -Format o) [voip-tunnel] disconnected (exit $LASTEXITCODE) — retrying in 5s"
    Start-Sleep -Seconds 5
}
