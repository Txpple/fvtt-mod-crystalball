/**
 * The caps, all in the Seer (the client's claims count for nothing): a message's length, each
 * user's rolling hour and calendar day, the table's calendar day and month in dollars. Calendar
 * days and months are the box's local time. The rules are pure functions over a list of calls;
 * the store keeps that list in memory, seeded from the ledger at start, and reserves a slot for a
 * call in flight so a burst of parallel requests cannot all pass one check.
 */

const HOUR = 3600 * 1000;

export const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export const startOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);

export const nextDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

export const nextMonth = d => new Date(d.getFullYear(), d.getMonth() + 1, 1);

const secondsUntil = (later, now) =>
  Math.max(1, Math.ceil((later.getTime() - now.getTime()) / 1000));

/**
 * The counts and sums one decision needs.
 * @param {Array<{ at: number, userId: string, cost: number }>} calls
 */
export function tally(calls, userId, now) {
  const t = now.getTime();
  const day = startOfDay(now).getTime();
  const month = startOfMonth(now).getTime();
  const mine = calls.filter(c => c.userId === userId);
  const hourTimes = mine.filter(c => c.at > t - HOUR && c.at <= t).map(c => c.at);
  const tableDay = calls.filter(c => c.at >= day && c.at <= t);
  const tableMonth = calls.filter(c => c.at >= month && c.at <= t);
  const sum = list => list.reduce((s, c) => s + (Number(c.cost) || 0), 0);
  return {
    hour: hourTimes.length,
    hourTimes: hourTimes.sort((a, b) => a - b),
    day: mine.filter(c => c.at >= day && c.at <= t).length,
    tableDay: { messages: tableDay.length, cost: sum(tableDay) },
    tableMonth: { messages: tableMonth.length, cost: sum(tableMonth) }
  };
}

/**
 * Whether a message may go to the model: null, or the refusal (status and the contract's body).
 * The table's caps are checked first, so a player is told the longest wait that applies.
 * @param {{ perUserHour: number, perUserDay: number, tableDayUsd: number, tableMonthUsd: number,
 *   messageChars: number }} limits
 */
export function decide({ limits, calls, userId, message, now }) {
  if (typeof message === "string" && message.length > limits.messageChars) {
    return { status: 413, body: { error: "too-long", limit: limits.messageChars } };
  }
  const t = tally(calls, userId, now);
  const refuse = (scope, retryAfter) => ({
    status: 429,
    body: { error: "limit", scope, retryAfter }
  });
  if (t.tableMonth.cost >= limits.tableMonthUsd)
    return refuse("table-month", secondsUntil(nextMonth(now), now));
  if (t.tableDay.cost >= limits.tableDayUsd)
    return refuse("table-day", secondsUntil(nextDay(now), now));
  if (t.day >= limits.perUserDay) return refuse("day", secondsUntil(nextDay(now), now));
  if (t.hour >= limits.perUserHour) {
    // The call that has to leave the window before one more fits.
    const leaving = t.hourTimes[t.hour - limits.perUserHour];
    return refuse("hour", secondsUntil(new Date(leaving + HOUR), now));
  }
  return null;
}

/** What `usage/me` reports and `done` names as remaining. */
export function usageReport({ limits, calls, userId, now }) {
  const t = tally(calls, userId, now);
  return {
    user: { hour: t.hour, day: t.day },
    table: { day: t.tableDay, month: t.tableMonth },
    limits: {
      perUserHour: limits.perUserHour,
      perUserDay: limits.perUserDay,
      tableDayUsd: limits.tableDayUsd,
      tableMonthUsd: limits.tableMonthUsd
    },
    remaining: {
      hour: Math.max(0, limits.perUserHour - t.hour),
      day: Math.max(0, limits.perUserDay - t.day)
    }
  };
}

/**
 * The in-memory store. Only this month's calls and the last hour's are kept; older ones can
 * decide nothing.
 * @param {{ limits: object, now?: () => Date }} options
 */
export function createLimits({ limits, now = () => new Date() }) {
  let calls = [];
  let next = 1;
  const pending = new Map();

  const prune = () => {
    const d = now();
    const keepFrom = Math.min(startOfMonth(d).getTime(), d.getTime() - HOUR);
    calls = calls.filter(c => c.at >= keepFrom);
  };
  const all = () => [...calls, ...pending.values()];

  return {
    /** Seed from ledger lines (`{ at: iso, userId, cost }`). */
    seed(lines) {
      for (const l of lines) {
        const at = Date.parse(l?.at);
        if (Number.isFinite(at) && l.userId)
          calls.push({ at, userId: l.userId, cost: Number(l.cost) || 0 });
      }
      prune();
    },

    /** The refusal for a message, or null. */
    check(userId, message) {
      prune();
      return decide({ limits, calls: all(), userId, message, now: now() });
    },

    /** Hold a slot for a call in flight; the ticket is committed with its cost or released. */
    reserve(userId) {
      const ticket = next++;
      pending.set(ticket, { at: now().getTime(), userId, cost: 0 });
      return ticket;
    },

    commit(ticket, cost) {
      const call = pending.get(ticket);
      if (!call) return;
      pending.delete(ticket);
      calls.push({ ...call, cost: Number(cost) || 0 });
    },

    release(ticket) {
      pending.delete(ticket);
    },

    report(userId) {
      prune();
      return usageReport({ limits, calls: all(), userId, now: now() });
    }
  };
}
