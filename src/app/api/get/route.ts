import { NextResponse, NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { sunoApi } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url);
      const songIds = url.searchParams.get('ids');
      const page = url.searchParams.get('page');
      const cookie = (await cookies()).toString();

      let audioInfo = [];
      if (songIds && songIds.length > 0) {
        const idsArray = songIds.split(',');
        audioInfo = await (await sunoApi(cookie)).get(idsArray, page);
      } else {
        audioInfo = await (await sunoApi(cookie)).get(undefined, page);
      }

      return new NextResponse(JSON.stringify(audioInfo), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error: any) {
      const rawDetail =
        error?.response?.data?.detail ||
        error?.response?.data?.error ||
        error?.message ||
        error?.toString?.() ||
        'Unknown error';
      const detailRaw = typeof rawDetail === 'string' ? rawDetail : JSON.stringify(rawDetail);
      const detail = detailRaw.length > 8000 ? `${detailRaw.slice(0, 8000)}…(truncated)` : detailRaw;

      let status = error?.response?.status || 500;
      // When Suno/Cloudflare rate-limits, the underlying client often sees 429s.
      // Surface 429 to downstream callers so they can back off instead of treating it as a hard failure.
      if (status === 500 && /429|rate limit|error 1015|cloudflare/i.test(detail)) status = 429;

      console.error('Error fetching audio:', status, detail);

      return new NextResponse(JSON.stringify({ error: detail }), {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...(status === 429 ? { 'Retry-After': '30' } : {}),
          ...corsHeaders
        }
      });
    }
  } else {
    return new NextResponse('Method Not Allowed', {
      headers: {
        Allow: 'GET',
        ...corsHeaders
      },
      status: 405
    });
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
}
