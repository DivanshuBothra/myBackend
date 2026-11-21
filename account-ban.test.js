const test = require('node:test');
const assert = require('node:assert/strict');
const {
    addOneCalendarMonth,
    getActiveAccountBan,
    getNextCancellationScore
} = require('./src/account-ban');

test('cancellation score reaches the ban threshold and never drops below it', () => {
    let score = 0;
    for (let index = 0; index < 10; index += 1) {
        score = getNextCancellationScore(score);
    }

    assert.equal(score, -10);
    assert.equal(getNextCancellationScore(score), -10);
});

test('one-month bans clamp to the final day of the following month', () => {
    assert.equal(
        addOneCalendarMonth(new Date('2025-01-31T12:00:00.000Z')).toISOString(),
        '2025-02-28T12:00:00.000Z'
    );
    assert.equal(
        addOneCalendarMonth(new Date('2024-01-31T12:00:00.000Z')).toISOString(),
        '2024-02-29T12:00:00.000Z'
    );
});

test('expired bans reset the cancellation score while active bans remain unchanged', async () => {
    const now = new Date('2025-06-01T00:00:00.000Z');
    let saveCount = 0;
    const activeUser = {
        accountBannedUntil: new Date('2025-06-02T00:00:00.000Z'),
        orderCancellationScore: -10,
        async save() { saveCount += 1; }
    };
    const expiredUser = {
        accountBannedUntil: new Date('2025-05-31T23:59:59.000Z'),
        orderCancellationScore: -10,
        orderCancellationResetAt: null,
        async save() { saveCount += 1; }
    };

    assert.equal(
        (await getActiveAccountBan(activeUser, now)).toISOString(),
        activeUser.accountBannedUntil.toISOString()
    );
    assert.equal(await getActiveAccountBan(expiredUser, now), null);
    assert.equal(expiredUser.accountBannedUntil, null);
    assert.equal(expiredUser.orderCancellationScore, 0);
    assert.equal(expiredUser.orderCancellationResetAt, now);
    assert.equal(saveCount, 1);
});
