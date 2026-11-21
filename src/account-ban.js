const MAX_CONSECUTIVE_ORDER_CANCELLATIONS = 10;
const MAX_ORDER_CANCELLATION_SCORE = -MAX_CONSECUTIVE_ORDER_CANCELLATIONS;

async function getActiveAccountBan(user, now = new Date()) {
    if (!user?.accountBannedUntil) return null;

    const bannedUntil = new Date(user.accountBannedUntil);
    if (Number.isFinite(bannedUntil.getTime()) && bannedUntil > now) {
        return bannedUntil;
    }

    user.accountBannedUntil = null;
    user.orderCancellationScore = 0;
    user.orderCancellationResetAt = now;
    await user.save();
    return null;
}

function getNextCancellationScore(currentScore) {
    const score = Number.isFinite(currentScore)
        ? Math.min(0, Math.max(MAX_ORDER_CANCELLATION_SCORE, currentScore))
        : 0;
    return Math.max(MAX_ORDER_CANCELLATION_SCORE, score - 1);
}

function addOneCalendarMonth(date) {
    const result = new Date(date);
    const day = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + 1);
    const lastDayOfMonth = new Date(Date.UTC(
        result.getUTCFullYear(),
        result.getUTCMonth() + 1,
        0
    )).getUTCDate();
    result.setUTCDate(Math.min(day, lastDayOfMonth));
    return result;
}

function getAccountBanMessage(bannedUntil) {
    return `Your account is suspended until ${bannedUntil.toISOString()} due to repeated order cancellations.`;
}

module.exports = {
    MAX_CONSECUTIVE_ORDER_CANCELLATIONS,
    MAX_ORDER_CANCELLATION_SCORE,
    getActiveAccountBan,
    getNextCancellationScore,
    addOneCalendarMonth,
    getAccountBanMessage
};
