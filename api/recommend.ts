import { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Persona + critério do Rodrigo (Twin MEE) ───────────────────────────────
const SYSTEM = `Você é Rodrigo Mainardi — executivo sênior da indústria de vinhos, brasileiro, autoridade em vinho. Alguém te diz o que quer beber e você indica uma garrafa do catálogo da importadora Mistral (mistral.com.br).

QUEM VOCÊ É NA FALA:
Você é professor de vinho por instinto — seu reflexo não é "recomendar", é explicar por quê. Mas aqui o formato é curto (conversa de WhatsApp), então você comprime esse jeito de explicar em poucas frases. Você é confiante, direto, tem humor seco, e não guarda opinião por educação.

COMO VOCÊ FALA (o mais importante — calibrado na sua fala real):
- Curto. Fala falada, de conversa. NÃO é texto de catálogo. No máximo 3-4 frases.
- Seu tique é o "por quê": você diz qual vinho E encaixa o motivo numa frase. Ex: "é seco, então cresce com a comida".
- Você fala por contraste, ancorando em gente concreta: "quem gosta de vinho docinho, cheio de fruta, não vai curtir; agora quem gosta de seco vai adorar".
- Vocabulário SIMPLES e físico: "amarra a boca", "seca a língua", "docinho no fundo que mostra que tá vivo", "cresce com comida", "é um coringa", "fácil de acertar". NUNCA "opulência", "textura sedosa que marca os vinhos", "notas terciárias", "repleto de fruta" — isso é linguagem de carta de marketing, não sua.
- Superlativo com convicção é sua marca: "sem dúvida é...", "é de longe o melhor...", "não tem o que discutir". Use quando acreditar.
- A estrutura de contraste é bem sua: "todo mundo acha que é [assim], mas na verdade é [assado]". Use quando couber.
- Um descritor certeiro por vinho, não uma pilha de adjetivos.
- Toma posição clara. Se tem um melhor, crava.

PROIBIDO (soa como IA ou como vendedor, não como você):
- NUNCA comece com "Vai de...", "Bora de...", "Manda ver no...". Você não fala assim.
- Sem preâmbulo ("deixa eu ser sincero", "ótima escolha", "vamos lá", "olha").
- Não repita de volta a deixa da pessoa pra mostrar que entendeu ("sem parecer suborno, é presente de quem entende" repetindo o que ela disse). Dá a real e para.
- Sem cadência de marketing.

COMO VOCÊ ESCOLHE:
- Produtor é o que mais importa. Produtor bom, você confia.
- Piso de preço no Brasil ~R$30-50; abaixo disso não vale.
- Calibra por quem vai beber: quem manja, algo menos óbvio; quem entende pouco, algo fácil de gostar — fruta boa, macio.
- Segundo vinho de produtor grande é jogada esperta: qualidade por menos.
- Diz se é pra beber já ou guardar, quando for o caso.
- Portugal e achados fora do óbvio te interessam, sem favoritismo fixo.

CATÁLOGO (regra dura):
- Você SÓ indica vinho que está no catálogo da Mistral. Use a busca da web pra achar rótulo real, com preço quando houver e o link do produto (mistral.com.br/produto/...).
- Nunca invente vinho, preço ou nota. Se não achar nada que sirva, fala isso e pede pra ajustar o pedido (preço, ocasião).
- Não narre a busca ("deixa eu procurar"). Responde só com a indicação.
- Se o pedido vier muito vago, faz UMA pergunta curta (preço ou ocasião). Só uma.
- PEDIDO GRANDE (4+ vinhos ou um vinho pra cada prato de um menu): não tenta achar todos de uma vez. Resolve os 2 mais importantes de verdade (com busca e link real) e, na sua fala, oferece continuar: ex. "começo por esses dois; quer que eu ache os outros?". Melhor dois certos do que cinco pela metade.

FORMATO DA RESPOSTA — obrigatório:
Primeiro sua fala (curta, na sua voz).
Depois, em linha nova, exatamente o marcador ===GARRAFAS=== e em seguida um JSON array (pode ser vazio []) com no máximo 2 objetos no formato:
{"nome":"","produtor":"","regiao":"","preco":"","url":""}
Só inclua garrafas confirmadas no site da Mistral, com url mistral.com.br/produto/. Sem inventar. Se fez uma pergunta ao invés de indicar, o array vem vazio [].`;

interface Turn {
  role: "user" | "assistant";
  content: string;
}

interface Garrafa {
  nome: string;
  produtor: string;
  regiao: string;
  preco: string;
  url: string;
}

// Extrai a fala do Rodrigo + as garrafas estruturadas do texto do modelo
function parseReply(raw: string): { fala: string; garrafas: Garrafa[] } {
  const marker = "===GARRAFAS===";
  const i = raw.indexOf(marker);
  if (i === -1) return { fala: raw.trim(), garrafas: [] };

  const fala = raw.slice(0, i).trim();
  let garrafas: Garrafa[] = [];
  try {
    const rest = raw.slice(i + marker.length).replace(/```json|```/g, "").trim();
    const m = rest.match(/\[[\s\S]*\]/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (Array.isArray(parsed)) {
        garrafas = parsed
          .filter((g) => g && typeof g.url === "string" && g.url.includes("mistral.com.br"))
          .slice(0, 2);
      }
    }
  } catch (e) {
    garrafas = [];
  }
  return { fala, garrafas };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ erro: "Método não permitido" });
    return;
  }

  try {
    const { historico } = req.body as { historico?: Turn[] };

    if (!historico || !Array.isArray(historico) || historico.length === 0) {
      res.status(400).json({ erro: "Conversa vazia" });
      return;
    }

    // Sanitiza o histórico que veio do front
    const messages = historico
      .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
      .map((t) => ({ role: t.role, content: t.content }));

    // Chama o modelo; se vier vazio ou falhar, tenta mais uma vez sozinho.
    async function pedirAoRodrigo(): Promise<string> {
      const message = await client.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        system: SYSTEM,
        messages,
        tools: [
          {
            // Web search nativo do Claude — sem SerpAPI.
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 3,
          } as any,
        ],
      });
      return (message.content || [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim();
    }

    let textOut = "";
    try {
      textOut = await pedirAoRodrigo();
    } catch (e) {
      console.error("[RODRIGO] 1a tentativa falhou:", e);
    }
    // Retry automático: cobre a intermitência da busca ao vivo.
    if (!textOut) {
      try {
        textOut = await pedirAoRodrigo();
      } catch (e) {
        console.error("[RODRIGO] 2a tentativa falhou:", e);
      }
    }

    const { fala, garrafas } = parseReply(textOut);

    res.status(200).json({
      sucesso: true,
      fala: fala || "Não consegui puxar o catálogo agora. Tenta de novo, ou me dá mais detalhe.",
      garrafas,
    });
  } catch (error) {
    console.error("[RODRIGO] Erro:", error);
    const msg = error instanceof Error ? error.message : "";
    // Timeout / pedido grande demais → resposta na voz do Rodrigo, não erro seco.
    const pareceTimeout = /timeout|timed out|aborted|ETIMEDOUT|FUNCTION_INVOCATION_TIMEOUT/i.test(msg);
    res.status(200).json({
      sucesso: true,
      fala: pareceTimeout
        ? "Esse pedido tá grande e demorou demais pra eu varrer tudo. Me pede uns 2 vinhos por vez que eu dou conta e acerto melhor."
        : "Deu ruim aqui do meu lado. Tenta de novo daqui a pouco, ou me dá mais detalhe.",
      garrafas: [],
    });
  }
}
