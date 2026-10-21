const japaneseHolidays = new Set(JAPAN_HOLIDAY_CALENDAR.dates);

function parseCalendarDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

// Excludes the return date and includes the delivery date. UTC avoids timezone/DST shifts.
// Four or more days are sufficient to establish that the three-day warning does not apply.
function businessDaysAfter(returnDate, deliveryDate) {
    const start = parseCalendarDate(returnDate);
    const end = parseCalendarDate(deliveryDate);
    if (!start || !end) return null;
    if (start.getUTCFullYear() < JAPAN_HOLIDAY_CALENDAR.firstYear || end.getUTCFullYear() > JAPAN_HOLIDAY_CALENDAR.lastYear) return null;
    let days = 0;
    for (const date = new Date(start); date < end && days < 4;) {
        date.setUTCDate(date.getUTCDate() + 1);
        const weekday = date.getUTCDay();
        if (weekday !== 0 && weekday !== 6 && !japaneseHolidays.has(date.toISOString().slice(0, 10))) days++;
    }
    return days;
}

function assessDeliveryDate(records, setName, deliveryDate) {
    if (!parseCalendarDate(deliveryDate)) return null;
    const latest = sortedRecords(records.filter(record => record.setName === setName))[0];
    if (!latest) return null;
    const reference = 'セット ' + setName + ' の最新案件 No.' + (latest.managementNo || '-') ;
    if (!parseCalendarDate(latest.expectedReturn)) {
        return { code: 'missing-return', message: reference + ' は返却予定日が未入力のため、納品までの間隔を確認できません。日程を確認してください。' };
    }
    const prefix = reference + ' の返却予定日：' + latest.expectedReturn + '。納品希望日：' + deliveryDate + '。';
    if (deliveryDate <= latest.expectedReturn) {
        return { code: 'overlap', message: prefix + ' 納品希望日が返却予定日以前です。貸出日程が重なっていないか確認してください。' };
    }
    const days = businessDaysAfter(latest.expectedReturn, deliveryDate);
    if (days === null) {
        return { code: 'unknown-calendar', message: prefix + ' 祝日データの対象期間外のため、営業日数を判定できません。カレンダーを確認してください。' };
    }
    if (days <= 3) {
        return { code: 'short-gap', businessDays: days, message: prefix + ' 返却予定日の翌日から納品希望日まで ' + days + ' 営業日で、3営業日以内です（土日祝を除く）。準備・発送が間に合うか確認してください。' };
    }
    return null;
}

function updateDeliveryWarning() {
    const notice = document.getElementById('delivery-warning');
    const assessment = editingId === null ? assessDeliveryDate(
        state.records,
        document.getElementById('f-set-name').value,
        document.getElementById('f-delivery-date').value
    ) : null;
    notice.textContent = assessment ? assessment.message : '';
    notice.classList.toggle('hidden', !assessment);
    return assessment;
}
