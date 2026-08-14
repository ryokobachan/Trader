import { handleWatchlistAfterHoursLongPoll } from "../../../../../platform/watchlist-after-hours-long-poll.server";

export async function POST(request: Request) {
  return handleWatchlistAfterHoursLongPoll(request);
}
