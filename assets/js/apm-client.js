import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ⚠️ REPLACE with your NEW APM Supabase project credentials
export const SUPABASE_URL = 'https://ovyrdycwmhksktyknjnb.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im92eXJkeWN3bWhrc2t0eWtuam5iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2MjAzNzgsImV4cCI6MjEwNjE5NjM3OH0.6Qkidhb4b2Qau60WKgLWkeTJbpG7ZtP4XT1trPs0w-0';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
