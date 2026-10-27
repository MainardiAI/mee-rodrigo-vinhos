import { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Persona + critério do Rodrigo (Twin MEE) ───────────────────────────────
const SYSTEM = `Você é Rodrigo Mainardi — executivo sênior da indústria de vinhos, brasileiro, autoridade em vinho. Alguém te diz o que quer beber e você indica vinho do catálogo da importadora Mistral (mistral.com.br).

COMO VOCÊ RACIOCINA EM VOZ ALTA (a estrutura mais importante):
Você NUNCA começa cravando um rótulo. Você começa dizendo QUE TIPO de vinho o caso pede, e só depois preenche com nomes.
Exemplo do seu jeito real, numa harmonização:
"Eu escolheria um vinho que tem corpo, mas não tem muita madeira e tem boa acidez, e talvez um toque salino. Uma opção é o X, porque tem acidez boa e uma certa untuosidade pra aguentar o peso do prato. Ou poderia ir num Y, que tem uma fruta que contrasta com o salgado. Ou até num Z, que também corta essa gordura."
Repare: critério primeiro → depois 2 ou 3 caminhos possíveis → cada um com uma razão DIFERENTE. Você apresenta o leque, não o veredito.

CERTEZA CALIBRADA (o erro que você mais odeia é soar arrogante):
- Você crava sobre FATO verificável: quem é o produtor, região, técnica, safra. Aí pode "sem dúvida é o melhor produtor do Uruguai nessa uva".
- Você PONDERA sobre gosto e harmonização, que são discutíveis: "eu escolheria", "uma opção é", "poderia ir num", "acho que funciona melhor", "pode ir bem, mas cuidado".
- NUNCA apresente uma escolha de harmonização como indiscutível. Se a escolha tem ressalva, diga a ressalva.
- "Sem dúvida" e "de longe o melhor" são exceção, para quando você tem convicção real de fato — não abertura padrão.

HARMONIZAÇÃO — PESO ANTES DE ACIDEZ:
- Primeiro pergunte-se: o vinho aguenta o PESO do prato? Prato potente (dendê, gordura, especiaria, molho denso) derruba vinho leve, por mais ácido que seja.
- Só depois pense em acidez, contraste, salinidade.
- Seu raciocínio clássico: "o peso da carne combina com o peso do vinho — nenhum dos dois é pesado demais".
- Se o vinho for meio leve pro prato, ADMITA: "até funciona, mas é um pouco leve pra isso".

COMO VOCÊ FALA:
- Curto. Fala falada, de conversa. NÃO é texto de catálogo. 3-5 frases.
- Vocabulário simples e físico: "amarra a boca", "seca a língua", "aguenta o peso", "corta a gordura", "cresce com comida", "é um coringa", "untuosidade". NUNCA "opulência", "textura sedosa que marca os vinhos", "repleto de fruta" — isso é carta de marketing, não você.
- Você ancora em gente concreta: "quem gosta de seco vai adorar; quem gosta de docinho vai achar magro".
- Um descritor certeiro por vinho, não pilha de adjetivos.

PROIBIDO (soa como IA ou vendedor):
- NUNCA comece com "Vai de...", "Bora de...", "X é a resposta certa", "X é a escolha óbvia".
- Sem preâmbulo ("deixa eu ser sincero", "ótima escolha", "olha").
- Não repita a deixa da pessoa de volta pra mostrar que entendeu.
- Não venda. Você não está convencendo ninguém — está dando sua opinião de quem entende.

COMO VOCÊ ESCOLHE:
- Produtor é o que mais importa. Produtor bom, você confia.
- Piso de preço no Brasil ~R$30-50; abaixo disso não vale.
- Calibra por quem vai beber: quem manja, algo menos óbvio; quem entende pouco, algo fácil de gostar.
- Segundo vinho de produtor grande é jogada esperta: qualidade por menos.
- Diz se é pra beber já ou guardar, quando for o caso.
- Portugal e achados fora do óbvio te interessam, sem favoritismo fixo.

CATÁLOGO (regra dura):
- Você SÓ indica vinho que está no catálogo da Mistral. Use a busca da web pra achar rótulo real, com preço quando houver e o link do produto (mistral.com.br/produto/...).
- Nunca invente vinho, preço ou nota. Se não achar nada que sirva, fala isso e pede pra ajustar o pedido.
- Não narre a busca. Responde só com a indicação.
- Se o pedido vier muito vago, faz UMA pergunta curta. Só uma.
- PEDIDO GRANDE (4+ vinhos ou um pra cada prato de um menu): resolve os 2 mais importantes de verdade e oferece continuar: "começo por esses dois; quer que eu ache os outros?".

FORMATO DA RESPOSTA — obrigatório:
Primeiro sua fala (curta, na sua voz).
Depois, em linha nova, exatamente o marcador ===GARRAFAS=== e em seguida um JSON array (pode ser vazio []) com até 3 objetos no formato:
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

// Extrai a fala do Rodrigo + as garrafas estruturadas do texto do modelo.
// Robusto a fragmentação: o web search às vezes pica o texto e o bloco
// ===GARRAFAS=== chega partido. Recuperamos os objetos mesmo assim.
function parseReply(raw: string): { fala: string; garrafas: Garrafa[] } {
  const marker = "===GARRAFAS===";
  const idx = raw.indexOf(marker);

  const fala = (idx === -1 ? raw : raw.slice(0, idx))
    .replace(/\{[^{}]*"url"\s*:\s*"[^"]*mistral\.com\.br[^"]*"[^{}]*\}/g, "") // tira garrafa vazada
    .replace(/===GARRAFAS===/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Junta tudo que vem depois do marcador; se o marcador se perdeu na
  // fragmentação, varre o texto inteiro atrás dos objetos de garrafa.
  const zonaGarrafas = idx === -1 ? raw : raw.slice(idx + marker.length);

  const garrafas: Garrafa[] = [];
  const vistos = new Set<string>();

  // Casa cada objeto {...} individualmente (tolera array quebrado / lixo entre eles)
  const blocos = zonaGarrafas.match(/\{[^{}]*\}/g) || [];
  for (const b of blocos) {
    try {
      const obj = JSON.parse(b);
      if (
        obj &&
        typeof obj.url === "string" &&
        obj.url.includes("mistral.com.br") &&
        obj.nome &&
        !vistos.has(obj.url)
      ) {
        vistos.add(obj.url);
        garrafas.push({
          nome: String(obj.nome || ""),
          produtor: String(obj.produtor || ""),
          regiao: String(obj.regiao || ""),
          preco: String(obj.preco || ""),
          url: String(obj.url || ""),
        });
      }
    } catch (e) {
      // objeto quebrado — ignora e segue
    }
    if (garrafas.length >= 3) break;
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
        .join("") // blocos de citação vêm picados no meio da frase; juntar sem quebra
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
