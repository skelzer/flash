// Anki-style SM-2 scheduler.
// Ratings: 1 = Again, 2 = Hard, 3 = Good, 4 = Easy

const MIN = 60_000;
const DAY = 86_400_000;

export const LEARN_STEPS = [1 * MIN, 10 * MIN];
export const RELEARN_STEPS = [10 * MIN];

const GRADUATE_DAYS = 1;
const EASY_DAYS = 4;
const MIN_EASE = 1.3;
const MAX_INTERVAL_DAYS = 36500;

// Returns the updated scheduling fields for a card given a rating.
// Pure function: no DB access, deterministic except for review-interval fuzz.
export function schedule(card, rating, now, fuzz = true) {
  const c = {
    state: card.state,
    step: card.step,
    interval: card.interval,
    ease: card.ease,
    reps: card.reps + 1,
    lapses: card.lapses,
    due: card.due,
  };

  if (c.state === 'new') {
    c.state = 'learning';
    c.step = 0;
  }

  if (c.state === 'learning' || c.state === 'relearning') {
    const steps = c.state === 'learning' ? LEARN_STEPS : RELEARN_STEPS;
    if (rating === 1) {
      c.step = 0;
      c.due = now + steps[0];
    } else if (rating === 2) {
      c.due = now + steps[Math.min(c.step, steps.length - 1)] * 1.5;
    } else if (rating === 3) {
      c.step += 1;
      if (c.step >= steps.length) {
        // graduate
        c.interval = c.state === 'learning' ? GRADUATE_DAYS : Math.max(1, c.interval);
        c.state = 'review';
        c.step = 0;
        c.due = now + c.interval * DAY;
      } else {
        c.due = now + steps[c.step];
      }
    } else {
      // easy: graduate immediately
      c.interval = c.state === 'learning' ? EASY_DAYS : Math.max(1, c.interval * 1.5);
      c.state = 'review';
      c.step = 0;
      c.due = now + c.interval * DAY;
    }
    return c;
  }

  // review state
  if (rating === 1) {
    c.lapses += 1;
    c.ease = Math.max(MIN_EASE, c.ease - 0.2);
    c.interval = Math.max(1, c.interval * 0.5);
    c.state = 'relearning';
    c.step = 0;
    c.due = now + RELEARN_STEPS[0];
    return c;
  }

  if (rating === 2) {
    c.ease = Math.max(MIN_EASE, c.ease - 0.15);
    c.interval = c.interval * 1.2;
  } else if (rating === 3) {
    c.interval = c.interval * c.ease;
  } else {
    c.ease = c.ease + 0.15;
    c.interval = c.interval * c.ease * 1.3;
  }
  c.interval = Math.min(MAX_INTERVAL_DAYS, Math.max(1, c.interval));
  if (fuzz && c.interval >= 2) {
    c.interval *= 1 + (Math.random() * 0.1 - 0.05);
  }
  c.due = now + c.interval * DAY;
  return c;
}

export function formatDelay(ms) {
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / MIN))}m`;
  if (ms < DAY) return `${Math.round(ms / 3_600_000)}h`;
  const days = ms / DAY;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${(days / 30.44).toFixed(1)}mo`;
  return `${(days / 365.25).toFixed(1)}y`;
}

// Labels shown on the four answer buttons for a given card.
export function predictions(card, now) {
  const out = {};
  for (const rating of [1, 2, 3, 4]) {
    const next = schedule(card, rating, now, false);
    out[rating] = formatDelay(next.due - now);
  }
  return out;
}
