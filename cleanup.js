const { cleanupRun } = require('./publisher');

cleanupRun().catch(() => {
    console.error('Bot cleanup failed. Check Supabase connectivity and credentials.');
    process.exitCode = 1;
});
