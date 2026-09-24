const { createClient } = require('@supabase/supabase-js');

const url = (process.env.SUPABASE_URL || '').trim();
const key = (process.env.SUPABASE_SECRET_KEY || '').trim();
if (!url || !key) {
  console.error('Supabase runner key check failed: required environment is missing.');
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

(async () => {
  const { count, error } = await supabase
    .from('system_settings')
    .select('key', { count: 'exact', head: true });
  if (error || count === null) {
    console.error('Supabase runner key check failed without exposing response details.');
    process.exitCode = 1;
    return;
  }
  console.log('Supabase runner key authenticated; database access verified without reading setting values.');
})().catch(() => {
  console.error('Supabase runner key check failed without exposing response details.');
  process.exitCode = 1;
});
