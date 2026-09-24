const { cleanupRun } = require('./publisher');

cleanupRun().then(() => {
    process.exit(0);
}).catch(() => {
    console.error('Bot cleanup failed. Check Supabase connectivity and credentials.');
    process.exit(1);
});
