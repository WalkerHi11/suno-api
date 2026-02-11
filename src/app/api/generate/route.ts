import { NextResponse, NextRequest } from "next/server";
import { cookies } from 'next/headers'
import { DEFAULT_MODEL, sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const { prompt, make_instrumental, model, wait_audio } = body;

      const audioInfo = await (await sunoApi((await cookies()).toString())).generate(
        prompt,
        Boolean(make_instrumental),
        model || DEFAULT_MODEL,
        Boolean(wait_audio)
      );

      return new NextResponse(JSON.stringify(audioInfo), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error: any) {
      const rawDetail = error?.response?.data?.detail || error?.message || error?.toString?.() || 'Unknown error';
      const detail = typeof rawDetail === 'string' ? rawDetail : JSON.stringify(rawDetail);
      let status = error?.response?.status || 500;
      if (
        status === 500 &&
        (detail.includes('Server busy') || detail.includes('Timed out waiting for capacity'))
      ) {
        status = 429;
      }
      console.error('Error generating audio:', status, detail);
      return new NextResponse(JSON.stringify({ error: detail }), {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...(status === 429 ? { 'Retry-After': '15' } : {}),
          ...corsHeaders
        }
      });
    }
  } else {
    return new NextResponse('Method Not Allowed', {
      headers: {
        Allow: 'POST',
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
