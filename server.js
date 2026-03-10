const http = require('http');
const fs = require('fs');
const path = require('path');

const port = 8082;

const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.woff': 'application/font-woff',
    '.ttf': 'application/font-ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.otf': 'application/font-otf',
    '.wasm': 'application/wasm'
};

try {
    http.createServer(function (request, response) {
        console.log('request ', request.url);

        let filePath = '.' + request.url.split('?')[0];
        if (filePath == './') {
            filePath = './index.html';
        }

        const extname = String(path.extname(filePath)).toLowerCase();
        const contentType = mimeTypes[extname] || 'application/octet-stream';

        fs.readFile(filePath, function (error, content) {
            if (error) {
                if (error.code == 'ENOENT') {
                    fs.readFile('./404.html', function (error, content) {
                        response.writeHead(404, { 'Content-Type': 'text/html' });
                        response.end(content || '404 Not Found', 'utf-8');
                    });
                }
                else {
                    response.writeHead(500);
                    response.end('Sorry, check with the site admin for error: ' + error.code + ' ..\n');
                }
            }
            else {
                response.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
                response.end(content, 'utf-8');
            }
        });

    }).listen(port, '0.0.0.0', () => {
        console.log('Server successfully listening on http://0.0.0.0:' + port);
    });
} catch (e) {
    console.error('Failed to start server:', e);
}

process.on('uncaughtException', (err) => {
    console.error('There was an uncaught error', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

console.log('Attempting to start server at http://localhost:' + port + '/');
console.log('Also accessible at http://127.0.0.1:' + port + '/');
