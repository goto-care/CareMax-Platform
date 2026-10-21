// Refresh after the Cabinet Office publishes the following year's holiday calendar.
// Usage: node scripts/update-jijogu-holidays.cjs [--from-file <official CSV path>]
const fs = require('node:fs');
const path = require('node:path');
const source = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv';
async function main() {
    const bytes = process.argv[2] === '--from-file'
        ? fs.readFileSync(process.argv[3])
        : new Uint8Array(await (await fetch(source).then(response => {
            if (!response.ok) throw new Error('Holiday download failed: ' + response.status);
            return response;
        })).arrayBuffer());
    const text = new TextDecoder('shift_jis').decode(bytes);
    const dates = text.split(/\r?\n/).flatMap(line => {
        const match = line.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2}),/);
        return match ? [match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0')] : [];
    }).sort();
    if (dates.length < 100 || new Set(dates).size !== dates.length) throw new Error('Invalid official holiday CSV');
    const data = {
        source, firstYear: Number(dates[0].slice(0, 4)), lastYear: Number(dates.at(-1).slice(0, 4)),
        checkedOn: new Date().toISOString().slice(0, 10), dates
    };
    const output = '// Official Cabinet Office holiday dates, including substitute and citizens holidays.\n' +
        'const JAPAN_HOLIDAY_CALENDAR = Object.freeze(' + JSON.stringify(data, null, 2) + ');\n';
    const root = path.resolve(__dirname, '..');
    fs.writeFileSync(path.join(root, 'jijogu/holidays-data.js'), output);
    if (fs.existsSync(path.join(root, 'dist/jijogu'))) fs.writeFileSync(path.join(root, 'dist/jijogu/holidays-data.js'), output);
    console.log('Official holidays updated: ' + data.firstYear + '–' + data.lastYear + ', ' + dates.length + ' dates');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
