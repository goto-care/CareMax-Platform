const japaneseHolidays = new Set(JAPAN_HOLIDAY_CALENDAR.dates);

// Agreed with Claude's rules.js (fitSet): from a return to the next delivery, leave 4 or more business days.
const MIN_GAP_BUSINESS_DAYS = 4;
// Dates filled in from the usage date (A3). People can still change them by hand.
const SCHEDULE_RULES = Object.freeze({ deliveryBeforeUsage: 1, shipBeforeDelivery: 2, returnAfterUsage: 10 });

function parseCalendarDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

function formatCalendarDate(date) {
    return date.toISOString().slice(0, 10);
}

function localToday(now = new Date()) {
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
}

function inHolidayCalendar(date) {
    const year = date.getUTCFullYear();
    return year >= JAPAN_HOLIDAY_CALENDAR.firstYear && year <= JAPAN_HOLIDAY_CALENDAR.lastYear;
}

function isBusinessDay(date) {
    const weekday = date.getUTCDay();
    return weekday !== 0 && weekday !== 6 && !japaneseHolidays.has(formatCalendarDate(date));
}

// Excludes the return date and includes the delivery date. UTC avoids timezone/DST shifts.
// Counting stops at the minimum gap: that is enough to know the warning does not apply.
function businessDaysAfter(returnDate, deliveryDate) {
    const start = parseCalendarDate(returnDate);
    const end = parseCalendarDate(deliveryDate);
    if (!start || !end) return null;
    if (start.getUTCFullYear() < JAPAN_HOLIDAY_CALENDAR.firstYear || end.getUTCFullYear() > JAPAN_HOLIDAY_CALENDAR.lastYear) return null;
    let days = 0;
    for (const date = new Date(start); date < end && days < MIN_GAP_BUSINESS_DAYS;) {
        date.setUTCDate(date.getUTCDate() + 1);
        if (isBusinessDay(date)) days++;
    }
    return days;
}

// Moves by n business days (negative = earlier). Returns '' for invalid dates or dates outside the holiday data.
function addBusinessDays(value, n) {
    const date = parseCalendarDate(value);
    if (!date || !Number.isInteger(n) || !inHolidayCalendar(date)) return '';
    const step = n < 0 ? -1 : 1;
    for (let left = Math.abs(n); left > 0;) {
        date.setUTCDate(date.getUTCDate() + step);
        if (!inHolidayCalendar(date)) return '';
        if (isBusinessDay(date)) left--;
    }
    return formatCalendarDate(date);
}

function scheduleFromUsage(usageDate) {
    const deliveryDate = addBusinessDays(usageDate, -SCHEDULE_RULES.deliveryBeforeUsage);
    return {
        deliveryDate,
        shipDate: addBusinessDays(deliveryDate, -SCHEDULE_RULES.shipBeforeDelivery),
        expectedReturn: addBusinessDays(usageDate, SCHEDULE_RULES.returnAfterUsage)
    };
}

// Finished records (checked or cancelled) no longer hold the set.
function isFinishedRecord(record) {
    return !!record.lastCheck || record.status === '取消';
}

function firstDate(...values) {
    return values.find(value => parseCalendarDate(value)) || '';
}

// The set is away from the delivery date until it is back (actual return first, else the expected return).
function recordRange(record) {
    const start = firstDate(record.deliveryDate, record.shipDate, record.usageDate);
    const end = firstDate(record.returnDate, record.expectedReturn);
    return { start, end, endLabel: end && end === record.returnDate ? '返却日' : '返却予定日' };
}

const SCHEDULE_ISSUE_ORDER = ['overlap', 'invalid-range', 'short-gap', 'missing-return', 'missing-own-return', 'unknown-calendar'];

// Checks the candidate against every unfinished record of the same set, before and after it (A4).
function assessSchedule(records, candidate) {
    const start = candidate.deliveryDate;
    if (!parseCalendarDate(start) || isFinishedRecord(candidate)) return null;
    const end = firstDate(candidate.returnDate, candidate.expectedReturn);
    const issues = [];
    if (end && end < start) {
        issues.push({ code: 'invalid-range', message: 'この案件の返却予定日（' + end + '）が納品希望日（' + start + '）より前です。' });
    }
    const others = records
        .filter(record => (record.setName || '') === (candidate.setName || '') && !isFinishedRecord(record))
        .filter(record => candidate.id === null || candidate.id === undefined || String(record.id) !== String(candidate.id))
        .map(record => ({ record, range: recordRange(record), label: 'No.' + (record.managementNo || '-') }))
        .sort((a, b) => (a.range.start || a.range.end).localeCompare(b.range.start || b.range.end));
    const gap = (from, to, message) => {
        const days = businessDaysAfter(from, to);
        if (days === null) {
            issues.push({ code: 'unknown-calendar', message: message('?') + ' 祝日データの対象期間外のため、営業日数を数えられません。カレンダーで確認してください。' });
        } else if (days < MIN_GAP_BUSINESS_DAYS) {
            issues.push({ code: 'short-gap', businessDays: days, message: message(days) });
        }
    };
    for (const { record, range, label } of others) {
        const { start: otherStart, end: otherEnd, endLabel } = range;
        if (otherEnd && otherEnd < start) {
            gap(otherEnd, start, days => label + ' の' + endLabel + '（' + otherEnd + '）から、この案件の納品希望日（' + start + '）まで ' + days + ' 営業日です。');
        } else if (otherStart && end && otherStart > end) {
            gap(end, otherStart, days => 'この案件の返却予定日（' + end + '）から、次の ' + label + ' の納品希望日（' + otherStart + '）まで ' + days + ' 営業日です。');
        } else if (!otherStart && !otherEnd) {
            // Returned records without dates are back in house; only loans and reservations block the set.
            if (recordPhase(record) !== 'returned') {
                issues.push({ code: 'missing-return', message: label + ' は納品希望日と返却予定日が未入力のため、重なりを確かめられません。' });
            }
        } else if (otherStart && otherStart > start && !end) {
            issues.push({ code: 'missing-own-return', message: 'この案件の返却予定日が未入力のため、後の ' + label + '（納品希望日 ' + otherStart + '）との間隔を確かめられません。' });
        } else if (otherEnd || otherStart >= start) {
            // Not separated on either side: the other record is away during this one, or starts inside it.
            issues.push({ code: 'overlap', message: label + '（' + (otherStart ? otherStart + '〜' : '〜') + (otherEnd || '返却予定日未入力') + '）と日程が重なっています。' });
        } else if (recordPhase(record) !== 'returned') {
            issues.push({ code: 'missing-return', message: label + ' は返却予定日が未入力のため、この案件と重ならないか確かめられません。' });
        }
    }
    if (!issues.length) return null;
    const code = SCHEDULE_ISSUE_ORDER.find(item => issues.some(issue => issue.code === item));
    const shortGap = issues.find(issue => issue.code === 'short-gap');
    return {
        code,
        businessDays: shortGap ? shortGap.businessDays : undefined,
        issues,
        message: 'セット ' + (candidate.setName || '未設定') + ' のほかの案件と日程を確認してください（返却から次の納品まで ' + MIN_GAP_BUSINESS_DAYS + ' 営業日以上あけます。土日祝を除く）。\n' +
            issues.map(issue => '・' + issue.message).join('\n')
    };
}

function assessDeliveryDate(records, setName, deliveryDate, expectedReturn = '', excludeId = null) {
    return assessSchedule(records, { id: excludeId, setName, deliveryDate, expectedReturn });
}

function updateDeliveryWarning() {
    const notice = document.getElementById('delivery-warning');
    const value = id => document.getElementById(id).value;
    const assessment = assessSchedule(state.records, {
        id: editingId,
        setName: value('f-set-name'),
        status: value('f-status'),
        deliveryDate: value('f-delivery-date'),
        expectedReturn: value('f-expected-return'),
        returnDate: value('f-return-date'),
        lastCheck: value('f-last-check')
    });
    notice.textContent = assessment ? assessment.message : '';
    notice.classList.toggle('hidden', !assessment);
    return assessment;
}

// Claude's jijogu-lending skill issues Sagawa labels every weekday morning for that day's ship date.
// It skips records registered on the ship date itself and ship dates already past (it asks in chat instead).
const LABEL_ISSUE_TIME = '9:15ごろ';
const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

function formatShortDate(value) {
    const date = parseCalendarDate(value);
    return date ? (date.getUTCMonth() + 1) + '/' + date.getUTCDate() + '（' + WEEKDAY_LABELS[date.getUTCDay()] + '）' : '';
}

function labelIssueInfo(record, { today = localToday(), isNew = false } = {}) {
    if (!record || record.shipMethod !== 'sagawa' || !record.autoLabel) return null;
    const shipDate = record.shipDate;
    if (!parseCalendarDate(shipDate)) {
        return { tone: 'pending', text: '発送日を入れると、送り状が自動で出る日をここに表示します。' };
    }
    const day = formatShortDate(shipDate);
    const created = record.createdAt ? new Date(record.createdAt) : null;
    const registeredToday = isNew || (created && Number.isFinite(created.getTime()) && localToday(created) === today);
    if (shipDate < today) {
        return { tone: 'warning', text: '発送日 ' + day + ' を過ぎているため、送り状は自動では出ません。' };
    }
    if (shipDate === today && registeredToday) {
        return { tone: 'warning', text: '発送日の当日に登録した案件は、送り状が自動では出ません（Claudeからチャットで確認が来ます）。' };
    }
    if (!isBusinessDay(parseCalendarDate(shipDate))) {
        return { tone: 'warning', text: '発送日 ' + day + ' は土日祝です。自動発行は平日の朝に動くため、送り状が出ないことがあります。発送日を確認してください。' };
    }
    if (shipDate === today) {
        return { tone: 'info', date: shipDate, text: '送り状は今日 ' + day + ' の朝（' + LABEL_ISSUE_TIME + '）に自動で出る予定です。' };
    }
    return { tone: 'info', date: shipDate, text: '送り状は ' + day + ' の朝（' + LABEL_ISSUE_TIME + '）に自動で出ます。' };
}

// Shown from October of the last year in the holiday data, so it can be refreshed in time (C1).
function holidayDataNotice(today = localToday()) {
    const lastYear = JAPAN_HOLIDAY_CALENDAR.lastYear;
    if (today < lastYear + '-10-01') return '';
    const prefix = today > lastYear + '-12-31'
        ? '祝日データが ' + lastYear + ' 年までのため、' + (lastYear + 1) + ' 年以降の営業日を数えられません。'
        : '営業日の計算に使う祝日データは ' + lastYear + ' 年 12 月までです。';
    return prefix + '内閣府が ' + (lastYear + 1) + ' 年の祝日を公表したら、祝日データを更新してください（scripts/update-jijogu-holidays.cjs）。';
}
