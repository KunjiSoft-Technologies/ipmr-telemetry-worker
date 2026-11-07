const moment = require('moment-timezone');

const getLocalMoment = (unix, _unit) => {
    const tz = _unit?.info?.timezone || "Asia/Karachi";
    if (unix) {
        return moment.unix(unix).tz(tz);
    } else {
        return moment().tz(tz);
    }
};

const getToday = (uid, unix = undefined, _unit) => {
    const now = getLocalMoment(unix, _unit);
    const now_seconds = now.hours() * 60 * 60 + now.minutes() * 60 + now.seconds();
    if (!_unit || !_unit.info) return now.format('YYYY-MM-DD');
    if (_unit.info.shift_a_start !== undefined && now_seconds <= (_unit.info.shift_a_start + 59)) {
        return now.subtract(1, 'days').format('YYYY-MM-DD');
    }
    return now.format('YYYY-MM-DD');
};

const whatHour = (uid, unix = undefined, _unit) => {
    const now = getLocalMoment(unix, _unit);
    let now_seconds = now.hours() * 60 * 60 + now.minutes() * 60 + now.seconds();
    if (!_unit || !_unit.info || _unit.info.shift_a_start === undefined) {
        return now.hours() + 1; // Fallback helper if shift_a_start is not defined
    }
    if (now_seconds <= _unit.info.shift_a_start) {
        now_seconds += 24 * 60 * 60;
    }
    const answer = Math.floor(((now_seconds - _unit.info.shift_a_start) / 3600) + 1);
    return answer;
};

const secToTime = (time) => {
    if (isNaN(time)) return time;
    time = Number(time);
    if (time > 86400) time = time - 86400;
    return (new Date(time * 1000).toISOString().substr(11, 8).slice(0, -3));
};

const getHourWindow = (uid, day, hourNum, _unit) => {
    const shiftStartSec = Number(_unit?.info?.shift_a_start || 25200);
    const startSec = shiftStartSec + ((Number(hourNum) - 1) * 3600);
    const endSec = shiftStartSec + (Number(hourNum) * 3600);
    const startStr = secToTime(startSec);
    const endStr = secToTime(endSec);

    const startDayOffset = Math.floor(startSec / 86400);
    const endDayOffset = Math.floor(endSec / 86400);
    const tz = _unit?.info?.timezone || 'Asia/Karachi';
    const startCalDay = moment.tz(day, tz).add(startDayOffset, 'days').format('YYYY-MM-DD');
    const endCalDay = moment.tz(day, tz).add(endDayOffset, 'days').format('YYYY-MM-DD');

    const startUnix = moment.tz(`${startCalDay} ${startStr}:00`, 'YYYY-MM-DD HH:mm:ss', tz).unix();
    const endUnix = moment.tz(`${endCalDay} ${endStr}:00`, 'YYYY-MM-DD HH:mm:ss', tz).unix();
    return { startUnix, endUnix, timeStr: `${startStr}-${endStr}` };
};

const isHourOffShift = (hourNum, _unit) => {
    const shifts = Number(_unit?.info?.shifts || 3);
    return hourNum > (shifts * 8);
};

module.exports = { getLocalMoment, getToday, whatHour, secToTime, getHourWindow, isHourOffShift };
