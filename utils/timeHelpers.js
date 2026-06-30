const moment = require('moment-timezone');

const getLocalMoment = (unix, _unit) => {
    const tz = _unit?.info?.timezone || "Asia/Karachi";
    if (unix) {
        return moment.unix(unix).utc();
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

module.exports = { getToday, whatHour, secToTime };
