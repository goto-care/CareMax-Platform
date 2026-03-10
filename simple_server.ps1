$port = 8082
$address = [System.Net.IPAddress]::Loopback
$server = New-Object System.Net.Sockets.TcpListener($address, $port)
$server.Start()
Write-Host "Simple Server started at http://127.0.0.1:$port/"
Write-Host "Press Ctrl+C to stop"

try {
    while ($true) {
        $client = $server.AcceptTcpClient()
        $stream = $client.GetStream()
        $reader = New-Object System.IO.StreamReader($stream)
        
        $line = $reader.ReadLine()
        if ($line) {
            Write-Host "$(Get-Date -Format 'HH:mm:ss') Request: $line"
            $tokens = $line.Split(' ')
            if ($tokens.Count -ge 2) {
                $path = $tokens[1]
                if ($path -eq "/") { $path = "/index.html" }
                $localPath = Join-Path $PSScriptRoot $path.TrimStart('/')
                
                if (Test-Path $localPath -PathType Leaf) {
                    $content = [System.IO.File]::ReadAllBytes($localPath)
                    $header = "HTTP/1.1 200 OK`r`nContent-Length: $($content.Length)`r`nContent-Type: text/html`r`nAccess-Control-Allow-Origin: *`r`nConnection: close`r`n`r`n"
                    $headerBytes = [System.Text.Encoding]::UTF8.GetBytes($header)
                    $stream.Write($headerBytes, 0, $headerBytes.Length)
                    $stream.Write($content, 0, $content.Length)
                } else {
                    $msg = "HTTP/1.1 404 Not Found`r`nConnection: close`r`n`r`n"
                    $msgBytes = [System.Text.Encoding]::UTF8.GetBytes($msg)
                    $stream.Write($msgBytes, 0, $msgBytes.Length)
                }
            }
        }
        $stream.Close()
        $client.Close()
    }
} finally {
    $server.Stop()
}
