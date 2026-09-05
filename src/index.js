// Pintt — Worker de extração de vídeo do Pinterest
//
// Rota: GET /api/resolve?url=https://www.pinterest.com/pin/123.../
//
// Deploy:
//   1. Crie um Worker novo no dashboard da Cloudflare (ou `wrangler init`).
//   2. Cole este arquivo como o código do Worker.
//   3. Troque ALLOWED_ORIGIN abaixo pelo domínio onde o Pintt está hospedado.
//   4. Publique e copie a URL (ex: https://pintt.SEU-USUARIO.workers.dev).
//   5. No pintt-v4.html, defina API_ENDPOINT = "<essa URL>/api/resolve".

const ALLOWED_ORIGIN = "*"; // TEMPORÁRIO: aceita qualquer origem, incluindo abrir o HTML local. Troque para o domínio real quando publicar o Pintt de verdade.

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

// Normaliza links encurtados (pin.it) para a URL completa do pin.
async function resolveShortLink(url) {
  if (!/pin\.it\//i.test(url)) return url;
  const res = await fetch(url, { redirect: "follow" });
  return res.url || url;
}

// Extrai a melhor URL de vídeo do HTML da página do pin.
function extractVideoUrl(html) {
  // 1) Tenta a meta tag og:video (ou og:video:secure_url / og:video:url)
  const metaPatterns = [
    /<meta[^>]+property=["']og:video:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:video:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const re of metaPatterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeHtmlEntities(m[1]);
  }

  // 2) Fallback: procura URLs .mp4 dentro do JSON embutido na página
  //    (o Pinterest guarda os dados do pin em um <script> com JSON grande).
  const mp4Matches = html.match(/https:\\?\/\\?\/[^"'\\]+\.mp4[^"'\\]*/gi);
  if (mp4Matches && mp4Matches.length > 0) {
    // Remove barras escapadas (\/ -> /) e pega a maior resolução disponível
    const cleaned = mp4Matches.map((u) => u.replace(/\\\//g, "/"));
    // Prioriza URLs que mencionem "1080" ou "720", senão pega a primeira
    const best =
      cleaned.find((u) => u.includes("1080p")) ||
      cleaned.find((u) => u.includes("720p")) ||
      cleaned[0];
    return decodeHtmlEntities(best);
  }

  return null;
}

function extractTitle(html) {
  const m = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
  );
  return m && m[1] ? decodeHtmlEntities(m[1]) : null;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function handleResolve(request) {
  const { searchParams } = new URL(request.url);
  const pinUrl = searchParams.get("url");

  if (!pinUrl) {
    return json({ error: "missing_url" }, 400);
  }
  if (!/pinterest\.[a-z.]+\/pin|pin\.it\//i.test(pinUrl)) {
    return json({ error: "not_a_pinterest_url" }, 400);
  }

  try {
    const finalUrl = await resolveShortLink(pinUrl);

    const pageRes = await fetch(finalUrl, {
      headers: {
        // Alguns User-Agents "de navegador" retornam mais metadata do que o padrão do fetch.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html",
      },
    });

    if (!pageRes.ok) {
      return json({ error: "fetch_failed", status: pageRes.status }, 502);
    }

    const html = await pageRes.text();
    const videoUrl = extractVideoUrl(html);
    const title = extractTitle(html);

    if (!videoUrl) {
      return json({ error: "no_video_found" }, 404);
    }

    return json({ videoUrl, title });
  } catch (err) {
    return json({ error: "internal_error", message: String(err) }, 500);
  }
}

// Faz o proxy do arquivo de vídeo, forçando o download (mesma origem do Worker)
// em vez de mandar o link direto do Pinterest — assim o Content-Disposition
// funciona e o navegador baixa o arquivo em vez de abrir o player.
async function handleDownload(request) {
  const { searchParams } = new URL(request.url);
  const videoUrl = searchParams.get("url");
  const filename = (searchParams.get("filename") || "pintt-video").replace(
    /[^a-zA-Z0-9-_ ]/g,
    ""
  );

  if (!videoUrl) {
    return json({ error: "missing_url" }, 400);
  }
  // Só permite fazer proxy de vídeos vindos de domínios do Pinterest,
  // pra evitar que o Worker seja usado como proxy genérico de qualquer URL.
  if (!/^https:\/\/[a-z0-9.-]*\.pinimg\.com\//i.test(videoUrl)) {
    return json({ error: "invalid_video_host" }, 400);
  }

  try {
    const videoRes = await fetch(videoUrl);

    if (!videoRes.ok || !videoRes.body) {
      return json({ error: "fetch_failed", status: videoRes.status }, 502);
    }

    const headers = new Headers(corsHeaders());
    headers.set(
      "Content-Type",
      videoRes.headers.get("Content-Type") || "video/mp4"
    );
    headers.set(
      "Content-Disposition",
      `attachment; filename="${filename}.mp4"`
    );
    const contentLength = videoRes.headers.get("Content-Length");
    if (contentLength) headers.set("Content-Length", contentLength);

    return new Response(videoRes.body, { status: 200, headers });
  } catch (err) {
    return json({ error: "internal_error", message: String(err) }, 500);
  }
}

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (pathname === "/api/resolve" && request.method === "GET") {
      return handleResolve(request);
    }

    if (pathname === "/api/download" && request.method === "GET") {
      return handleDownload(request);
    }

    return json({ error: "not_found" }, 404);
  },
};

// trigger deploy
    
