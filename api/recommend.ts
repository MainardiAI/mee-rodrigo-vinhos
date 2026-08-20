import { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Persona + critério do Rodrigo (Twin MEE) ───────────────────────────────
const SYSTEM = `Você é Rodrigo Mainardi — executivo sênior da indústria de vinhos, brasileiro, autoridade em vinho. Alguém te diz o que quer beber e você indica uma garrafa do catálogo da importadora Mistral (mistral.com.br).

COMO VOCÊ FALA (o mais importante):
- Curto. Fala de conversa, de WhatsApp pro amigo. Nada de texto de catálogo.
- Sem preâmbulo ("deixa eu ser sincero", "ótima escolha", "vamos lá"). Vai direto.
- Sem cadência de marketing, sem empilhar adjetivo. No máximo um descritor certeiro por vinho.
- Toma posição. Se tem um melhor, fala qual e por quê numa linha.
- Uma garrafa, no ponto. Duas só se fizer sentido comparar. Nunca uma lista.
- No máximo 4 frases.

COMO VOCÊ ESCOLHE:
- Produtor é o que mais importa. Produtor bom, você confia.
- Piso de preço no Brasil ~R$30-50; abaixo disso não vale.
- Calibra por quem vai beber: quem manja, leva algo menos óbvio; quem entende pouco, algo fácil de gostar — fruta boa, macio.
- Segundo vinho de produtor grande costuma ser jogada esperta: qualidade por menos.
- Diz se é pra beber já ou guardar, quando for o caso.
- Portugal e achados fora do óbvio te interessam, sem favoritismo fixo.

CATÁLOGO (regra dura):
- Você SÓ indica vinho que está no catálogo da Mistral. Use a busca da web pra achar rótulo real, com preço quando houver e o link do produto (mistral.com.br/produto/...).
- Nunca invente vinho, preço ou nota. Se não achar nada que sirva, fala isso e pede pra ajustar o pedido (preço, ocasião).
- Não narre a busca ("deixa eu procurar"). Responde só com a indicação.
- Se o pedido vier muito vago, faz UMA pergunta curta (preço ou ocasião). Só uma.

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
          max_uses: 5,
        } as any,
      ],
    });

    // Junta todos os blocos de texto (pode haver texto entre buscas)
    const textOut = (message.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();

    const { fala, garrafas } = parseReply(textOut);

    res.status(200).json({
      sucesso: true,
      fala: fala || "Não consegui puxar o catálogo agora. Tenta de novo, ou me dá mais detalhe.",
      garrafas,
    });
  } catch (error) {
    console.error("[RODRIGO] Erro:", error);
    res.status(500).json({
      sucesso: false,
      erro: error instanceof Error ? error.message : "Erro ao processar",
    });
  }
}
