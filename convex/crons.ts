import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();
crons.interval('sweep rooms', { minutes: 5 }, internal.rooms.sweep, {});
export default crons;
