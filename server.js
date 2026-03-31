import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const PORT = Number(process.env.PORT || 3000);

const CONFIG = {
  freightFreeThreshold: Number(process.env.FREIGHT_FREE_THRESHOLD || 79),
  classicFeePct: Number(process.env.CLASSIC_FEE_PCT || 11.5),
  premiumFeePct: Number(process.env.PREMIUM_FEE_PCT || 16.5),
  defaultReferenceShippingCost: Number(process.env.DEFAULT_REFERENCE_SHIPPING_COST || 0),
  estimatedReferenceShippingPct: Number(process.env.ESTIMATED_REFERENCE_SHIPPING_PCT || 15),
  dynamicShippingEnabled:
    String(process.env.DYNAMIC_SHIPPING_ENABLED || "true").toLowerCase() !== "false",
  weightBaseLeve: Number(process.env.WEIGHT_BASE_LEVE || 18),
  weightBaseMedio: Number(process.env.WEIGHT_BASE_MEDIO || 22),
  weightBasePesado: Number(process.env.WEIGHT_BASE_PESADO || 28),
  weightBaseMuitoPesado: Number(process.env.WEIGHT_BASE_MUITO_PESADO || 35),
  userAgent:
    process.env.HTTP_USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
};

function clampNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toMoney(value) {
  return Math.round((clampNumber(value, 0) + Number.EPSILON) * 100) / 100;
}

function decodeHtmlEntities(str) {
  if (!str) return "";
  return String(str)
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#x27;", "'")
    .replaceAll("&nbsp;", " ");
}

function stripTags(str) {
  return decodeHtmlEntities(
    String(str || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function normalizeUrl(url) {
  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
}

function isMercadoLivreUrl(input) {
  try {
    const url = new URL(input);
    return /mercadolivre\.com(\.\w+)?$/i.test(url.hostname) || /mercadolivre/i.test(url.hostname);
  } catch {
    return false;
  }
}

function inferCandidates(input) {
  const raw = String(input || "").trim();
  if (!raw) return [];

  if (/^https?:\/\//i.test(raw)) {
    const normalized = normalizeUrl(raw);
    return normalized ? [normalized] : [];
  }

  const id = raw.toUpperCase().trim();
  if (/^MLB[A-Z0-9-]+$/i.test(id)) {
    return [
      `https://produto.mercadolivre.com.br/${id}`,
      `https://www.mercadolivre.com.br/p/${id}`,
      `https://lista.mercadolivre.com.br/${id}`
    ];
  }

  return [];
}

function parseFirstMatch(text, regex, group = 1) {
  const match = String(text || "").match(regex);
  return match ? match[group] : null;
}

function parseJsonLdObjects(html) {
  const scripts = [
    ...String(html || "").matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )
  ];

  const objects = [];

  for (const match of scripts) {
    const raw = (match[1] || "").trim();
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) objects.push(item);
      } else {
        objects.push(parsed);
      }
    } catch {
      // ignora
    }
  }

  return objects;
}

function parsePriceLoose(str) {
  if (str == null) return null;

  const raw = String(str).trim();
  if (!raw) return null;

  let cleaned = raw.replace(/[^\d,.-]/g, "");

  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");

  if (hasComma && hasDot) {
    const lastComma = cleaned.lastIndexOf(",");
    const lastDot = cleaned.lastIndexOf(".");

    if (lastComma > lastDot) {
      cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      cleaned = cleaned.replace(/,/g, "");
    }
  } else if (hasComma) {
    const parts = cleaned.split(",");
    if (parts.length === 2 && parts[1].length <= 2) {
      cleaned = parts[0].replace(/\./g, "") + "." + parts[1];
    } else {
      cleaned = cleaned.replace(/,/g, "");
    }
  } else if (hasDot) {
    const parts = cleaned.split(".");
    if (parts.length === 2 && parts[1].length <= 2) {
      // decimal válido
    } else {
      cleaned = cleaned.replace(/\./g, "");
    }
  }

  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function parseTitle(html) {
  const ogTitle = parseFirstMatch(
    html,
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"]+)["']/i
  );
  if (ogTitle) return stripTags(ogTitle);

  const titleTag = parseFirstMatch(html, /<title>([\s\S]*?)<\/title>/i);
  if (titleTag) return stripTags(titleTag);

  return "";
}

function parseImage(html) {
  const ogImage = parseFirstMatch(
    html,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"]+)["']/i
  );
  if (ogImage) return ogImage;

  const dataZoom = parseFirstMatch(html, /"secure_thumbnail":"([^"]+)"/i);
  if (dataZoom) return dataZoom.replaceAll("\\u002F", "/").replaceAll("\\/", "/");

  return "";
}

function parseCanonicalUrl(html) {
  const ogUrl = parseFirstMatch(
    html,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"]+)["']/i
  );
  if (ogUrl) return ogUrl;

  const canonical = parseFirstMatch(
    html,
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"]+)["']/i
  );
  if (canonical) return canonical;

  return "";
}

function parsePriceAndOriginalPrice(html) {
  const objects = parseJsonLdObjects(html);

  for (const obj of objects) {
    if (!obj || typeof obj !== "object") continue;

    const type = Array.isArray(obj["@type"]) ? obj["@type"].join(" ") : obj["@type"];
    if (!type || !/Product/i.test(String(type))) continue;

    const offers = obj.offers;
    const offer = Array.isArray(offers) ? offers[0] : offers;

    let price = null;
    let originalPrice = null;

    if (offer?.price != null) price = parsePriceLoose(offer.price);
    if (offer?.highPrice != null) originalPrice = parsePriceLoose(offer.highPrice);

    if (price != null || originalPrice != null) {
      return { price, originalPrice };
    }
  }

  const metaPrice = parseFirstMatch(
    html,
    /<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"]+)["']/i
  );

  const oldPriceMeta =
    parseFirstMatch(
      html,
      /<meta[^>]+(?:property|name)=["']product:original_price["'][^>]+content=["']([^"]+)["']/i
    ) ||
    parseFirstMatch(
      html,
      /<meta[^>]+(?:property|name)=["']original_price["'][^>]+content=["']([^"]+)["']/i
    );

  if (metaPrice || oldPriceMeta) {
    return {
      price: metaPrice ? parsePriceLoose(metaPrice) : null,
      originalPrice: oldPriceMeta ? parsePriceLoose(oldPriceMeta) : null
    };
  }

  const quotedPrice = parseFirstMatch(html, /"price"\s*:\s*"([\d\.,]+)"/i);

  const strikePatterns = [
    /<s[^>]*>[\s\S]*?R\$\s*([\d\.,]+)[\s\S]*?<\/s>/i,
    /<del[^>]*>[\s\S]*?R\$\s*([\d\.,]+)[\s\S]*?<\/del>/i,
    /"original_price"\s*:\s*"([\d\.,]+)"/i,
    /"oldPrice"\s*:\s*"([\d\.,]+)"/i
  ];

  let originalPrice = null;
  for (const pattern of strikePatterns) {
    const found = parseFirstMatch(html, pattern);
    if (found) {
      originalPrice = parsePriceLoose(found);
      if (originalPrice != null) break;
    }
  }

  if (quotedPrice || originalPrice != null) {
    return {
      price: quotedPrice ? parsePriceLoose(quotedPrice) : null,
      originalPrice
    };
  }

  const plainPrice = parseFirstMatch(html, /R\$\s*([\d\.,]+)/i);
  if (plainPrice) {
    return {
      price: parsePriceLoose(plainPrice),
      originalPrice: originalPrice != null ? originalPrice : null
    };
  }

  return {
    price: null,
    originalPrice: null
  };
}

function parseSoldQuantity(html) {
  const patterns = [
    // Padrão para "+5mil vendidos", "5mil vendidos", "+5k vendidos"
    /\+?\s*(\d+(?:[.,]\d+)?)\s*(?:mil|k)\s*vendidos?/i,
    // Padrão para "Mais de 5 mil vendidos"
    /Mais de\s+(\d+(?:[.,]\d+)?)\s*(?:mil|k)?\s*vendidos?/i,
    // Padrão para "5 vendidos", "+5 vendidos"
    /(\d+(?:[.,]\d+)?)\s*vendidos?/i,
    // Padrão para "5 unidades vendidas"
    /(\d+(?:[.,]\d+)?)\s*unidades?\s*vendidas?/i
  ];

  for (const pattern of patterns) {
    const match = String(html || "").match(pattern);
    if (match) {
      let numberStr = match[1];
      
      // Converte vírgula decimal para ponto
      numberStr = numberStr.replace(",", ".");
      
      let quantity = parseFloat(numberStr);
      
      if (Number.isFinite(quantity)) {
        // Verifica se tem "mil" ou "k" no texto capturado
        const fullMatch = match[0];
        if (fullMatch.match(/(mil|k)/i) && quantity < 1000) {
          quantity = quantity * 1000;
        }
        // Arredonda para inteiro
        return Math.round(quantity);
      }
    }
  }

  return null;
}

function parseInstallment(html) {
  const patterns = [
    /(\d+)\s*x\s*R\$\s*([\d\.,]+)/i,
    /(\d+)\s*x\s*de\s*R\$\s*([\d\.,]+)/i,
    /em\s*(\d+)\s*parcelas\s*de\s*R\$\s*([\d\.,]+)/i
  ];

  for (const pattern of patterns) {
    const match = String(html || "").match(pattern);
    if (match) {
      return `${match[1]}x de R$ ${match[2]}`;
    }
  }

  return "";
}

function parseFreeShipping(html) {
  return /frete grátis/i.test(String(html || ""));
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": CONFIG.userAgent,
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    },
    redirect: "follow"
  });

  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    html: await response.text()
  };
}

async function extractReferencePublicData(input) {
  const candidates = inferCandidates(input);

  if (!candidates.length) {
    return {
      ok: false,
      message: "Cole uma URL completa do anúncio. Para o MVP, a URL funciona melhor que o ID puro.",
      extracted: null
    };
  }

  let lastError = null;

  for (const candidate of candidates) {
    try {
      const result = await fetchHtml(candidate);

      if (!result.ok || !result.html) {
        lastError = `HTTP ${result.status} ao abrir ${candidate}`;
        continue;
      }

      const html = result.html;
      const title = parseTitle(html);
      const image = parseImage(html);
      const canonicalUrl = parseCanonicalUrl(html) || result.url || candidate;
      const { price, originalPrice } = parsePriceAndOriginalPrice(html);
      const soldQuantity = parseSoldQuantity(html);
      const installment = parseInstallment(html);
      const shippingFree = parseFreeShipping(html);

      const extracted = {
        input,
        sourceUrl: candidate,
        finalUrl: canonicalUrl,
        title: title || "",
        price: price != null ? toMoney(price) : null,
        originalPrice: originalPrice != null ? toMoney(originalPrice) : null,
        soldQuantity: soldQuantity != null ? soldQuantity : null,
        shippingFree: !!shippingFree,
        installment: installment || "",
        image: image || "",
        link: canonicalUrl || candidate,
        exposure: "classic",
        reputation: "red"
      };

      const hasUsefulData =
        extracted.title ||
        extracted.price != null ||
        extracted.image ||
        extracted.link;

      if (!hasUsefulData) {
        lastError = `Não foi possível extrair dados úteis de ${candidate}`;
        continue;
      }

      return {
        ok: true,
        message: "Dados públicos extraídos. Revise os campos antes de calcular, porque o HTML do anúncio pode variar.",
        extracted
      };
    } catch (error) {
      lastError = error.message || "Falha ao extrair dados públicos.";
    }
  }

  return {
    ok: false,
    message: lastError || "Não foi possível extrair os dados públicos automaticamente.",
    extracted: null
  };
}

function exposureToFeePct(exposure) {
  const normalized = String(exposure || "").toLowerCase();
  if (normalized === "premium") return CONFIG.premiumFeePct;
  return CONFIG.classicFeePct;
}

function normalizeExposure(exposure) {
  return String(exposure || "").toLowerCase() === "premium" ? "premium" : "classic";
}

function normalizeWeightCategory(weightCategory) {
  const value = String(weightCategory || "").toLowerCase().trim();

  if (value === "leve") return "leve";
  if (value === "medio") return "medio";
  if (value === "médio") return "medio";
  if (value === "pesado") return "pesado";
  if (value === "muito_pesado") return "muito_pesado";
  if (value === "muito pesado") return "muito_pesado";

  return "medio";
}

function normalizeReputation(reputation) {
  const value = String(reputation || "").toLowerCase().trim();

  if (value === "green" || value === "verde") return "green";
  if (value === "yellow" || value === "amarela" || value === "amarelo") return "yellow";
  if (value === "red" || value === "nova" || value === "sem reputacao" || value === "sem reputação") {
    return "red";
  }

  return "red";
}

function getBaseShippingByWeight(weightCategory) {
  const normalized = normalizeWeightCategory(weightCategory);

  if (normalized === "leve") return toMoney(CONFIG.weightBaseLeve);
  if (normalized === "pesado") return toMoney(CONFIG.weightBasePesado);
  if (normalized === "muito_pesado") return toMoney(CONFIG.weightBaseMuitoPesado);
  return toMoney(CONFIG.weightBaseMedio);
}

function getShippingMultiplier(reputation, exposure) {
  const rep = normalizeReputation(reputation);
  const exp = normalizeExposure(exposure);

  if (rep === "green") {
    return exp === "premium" ? 0.4 : 0.6;
  }

  if (rep === "yellow") {
    return exp === "premium" ? 0.6 : 0.8;
  }

  return exp === "premium" ? 0.8 : 1;
}

function calculateDynamicShippingCost({ weightCategory, reputation, exposure }) {
  if (!CONFIG.dynamicShippingEnabled) return 0;

  const baseShipping = getBaseShippingByWeight(weightCategory);
  const multiplier = getShippingMultiplier(reputation, exposure);

  return toMoney(baseShipping * multiplier);
}

function demandLabel(soldQuantity) {
  const sold = clampNumber(soldQuantity, 0);

  if (sold >= 100) return "alta";
  if (sold >= 20) return "média";
  return "baixa";
}

function priceLabel(myPrice, competitorPrice) {
  const mine = clampNumber(myPrice, 0);
  const competitor = clampNumber(competitorPrice, 0);

  if (competitor <= 0) return "indefinido";

  const diffPct = ((mine - competitor) / competitor) * 100;

  if (diffPct <= 0) return "competitivo";
  if (diffPct <= 3) return "igual";
  return "caro";
}

function marginLabel(marginPct) {
  const margin = clampNumber(marginPct, 0);

  if (margin >= 20) return "boa";
  if (margin >= 10) return "atenção";
  return "ruim";
}

function decisionLabel({ demand, margin, price }) {
  if (
    (demand === "alta" || demand === "média") &&
    margin === "boa" &&
    (price === "competitivo" || price === "igual")
  ) {
    return "VALE A PENA";
  }

  if ((demand === "alta" || demand === "média") && margin !== "ruim") {
    return "AJUSTAR PREÇO OU CUSTO";
  }

  return "NÃO VALE A PENA";
}

function recommendationText({ demand, margin, price, competitorPrice, myPrice }) {
  if (margin === "ruim") {
    return "Sua margem está fraca. O primeiro ajuste deve ser custo ou preço.";
  }

  if (price === "caro") {
    return "Seu preço está acima da referência. Reveja o preço de venda ou aceite competir em outro posicionamento.";
  }

  if (demand === "baixa") {
    return "A demanda aparente está baixa. Faça um teste com cautela antes de investir mais.";
  }

  if (myPrice < competitorPrice) {
    return "Seu preço ficou competitivo e a operação parece saudável. É um bom cenário para testar.";
  }

  return "O cenário é aceitável, mas vale simular mais de um preço antes de decidir.";
}

function calculateAnalysis(reference, simulation) {
  // Processa a reputação do concorrente considerando a flag profissional
  let refReputation = normalizeReputation(reference.reputation || "red");
  let refExposure = normalizeExposure(reference.exposure || "classic");
  
  // Se a flag profissional estiver marcada, força premium e verde
  const assumeProfessionalCompetitor = reference.assumeProfessionalCompetitor === true || 
                                        reference.assumeProfessionalCompetitor === "true";
  
  if (assumeProfessionalCompetitor) {
    refExposure = "premium";
    refReputation = "green";
  }

  const refPrice = toMoney(reference.price);
  const refOriginalPrice =
    reference.originalPrice != null && reference.originalPrice !== ""
      ? toMoney(reference.originalPrice)
      : null;
  const refSoldQty = clampNumber(reference.soldQuantity, 0);
  const refShippingFree = !!reference.shippingFree;
  const refInstallment = String(reference.installment || "");
  const refManualShippingCost = clampNumber(reference.shippingCostEstimate, 0);

  const myCostProduct = toMoney(simulation.costProduct);
  const mySalePrice = toMoney(simulation.salePrice);
  const myExposure = normalizeExposure(simulation.exposure || "classic");
  const myShippingFree = simulation.shippingFree === true || simulation.shippingFree === "true";
  const myShippingCostSellerEntered = toMoney(clampNumber(simulation.shippingCostSeller, 0));
  const myWeightCategory = normalizeWeightCategory(simulation.weightCategory || "medio");
  const myReputation = normalizeReputation(simulation.reputation || "red");

  const refFeePct = exposureToFeePct(refExposure);
  const refFeeValue = toMoney(refPrice * (refFeePct / 100));

  let refShippingCost = 0;
  let refShippingCostSource = "não_aplicado";
  let refShippingReputationUsed = refReputation;
  let refExposureUsed = refExposure;

  // Lógica de frete do concorrente: prioridade para manual
  if (refShippingFree) {
    if (refManualShippingCost > 0) {
      // PRIORIDADE: valor manual preenchido
      refShippingCost = toMoney(refManualShippingCost);
      refShippingCostSource = "manual";
    } else if (assumeProfessionalCompetitor) {
      refShippingReputationUsed = "green";
      refExposureUsed = "premium";
      refShippingCost = calculateDynamicShippingCost({
        price: refPrice,
        weightCategory: myWeightCategory,
        reputation: refShippingReputationUsed,
        exposure: refExposureUsed
      });
      refShippingCostSource = "dynamic-professional";
    } else if (CONFIG.dynamicShippingEnabled) {
      refShippingCost = calculateDynamicShippingCost({
        price: refPrice,
        weightCategory: myWeightCategory,
        reputation: refReputation,
        exposure: refExposure
      });
      refShippingCostSource = "dynamic-reference";
    } else if (CONFIG.defaultReferenceShippingCost > 0) {
      refShippingCost = toMoney(CONFIG.defaultReferenceShippingCost);
      refShippingCostSource = "config";
    } else {
      refShippingCost = toMoney(refPrice * (CONFIG.estimatedReferenceShippingPct / 100));
      refShippingCostSource = "estimado";
    }
  }

  const refEstimatedNet = toMoney(refPrice - refFeeValue - refShippingCost);

  const suggestedShippingFree = mySalePrice >= CONFIG.freightFreeThreshold;
  const myFeePct = exposureToFeePct(myExposure);
  const myFeeValue = toMoney(mySalePrice * (myFeePct / 100));

  let myFreightApplied = 0;
  let myFreightSource = "não_aplicado";

  // ✅ LÓGICA CORRIGIDA: Checkbox indica se o VENDEDOR paga o frete
  const sellerPaysFreight = myShippingFree;
  
  if (sellerPaysFreight) {
    // Vendedor vai pagar o frete - entra no custo
    if (myShippingCostSellerEntered > 0) {
      // PRIORIDADE: valor manual informado
      myFreightApplied = myShippingCostSellerEntered;
      myFreightSource = "manual";
    } else if (CONFIG.dynamicShippingEnabled) {
      // Cálculo dinâmico baseado em peso, reputação, exposição e preço
      myFreightApplied = calculateDynamicShippingCost({
        price: mySalePrice,
        weightCategory: myWeightCategory,
        reputation: myReputation,
        exposure: myExposure
      });
      myFreightSource = "dynamic";
    } else {
      myFreightApplied = 0;
      myFreightSource = "disabled";
    }
  } else {
    // Vendedor NÃO paga frete - comprador paga
    // NÃO entra no custo do vendedor
    myFreightApplied = 0;
    myFreightSource = "comprador_paga";
  }

  const myTotalCost = toMoney(myCostProduct + myFeeValue + myFreightApplied);
  const myNetProfit = toMoney(mySalePrice - myTotalCost);
  const myMarginPct = mySalePrice > 0 ? toMoney((myNetProfit / mySalePrice) * 100) : 0;

  const priceDifference = toMoney(mySalePrice - refPrice);
  const priceDifferencePct = refPrice > 0 ? toMoney((priceDifference / refPrice) * 100) : 0;

  const demand = demandLabel(refSoldQty);
  const pricePosition = priceLabel(mySalePrice, refPrice);
  const margin = marginLabel(myMarginPct);
  const decision = decisionLabel({ demand, margin, price: pricePosition });
  const recommendation = recommendationText({
    demand,
    margin,
    price: pricePosition,
    competitorPrice: refPrice,
    myPrice: mySalePrice
  });

  return {
    config: {
      freightFreeThreshold: CONFIG.freightFreeThreshold,
      classicFeePct: CONFIG.classicFeePct,
      premiumFeePct: CONFIG.premiumFeePct,
      estimatedReferenceShippingPct: CONFIG.estimatedReferenceShippingPct,
      dynamicShippingEnabled: CONFIG.dynamicShippingEnabled,
      weightBaseLeve: CONFIG.weightBaseLeve,
      weightBaseMedio: CONFIG.weightBaseMedio,
      weightBasePesado: CONFIG.weightBasePesado,
      weightBaseMuitoPesado: CONFIG.weightBaseMuitoPesado
    },
    reference: {
      title: reference.title || "",
      image: reference.image || "",
      link: reference.link || "",
      price: refPrice,
      originalPrice: refOriginalPrice,
      soldQuantity: refSoldQty,
      shippingFree: refShippingFree,
      installment: refInstallment,
      exposure: refExposure,
      reputation: refReputation,
      exposureUsedForShipping: refExposureUsed,
      assumedProfessionalCompetitor: assumeProfessionalCompetitor,
      shippingReputationUsed: refShippingReputationUsed,
      feePct: refFeePct,
      feeValue: refFeeValue,
      shippingCostEstimate: refShippingCost,
      shippingCostSource: refShippingCostSource,
      estimatedNet: refEstimatedNet
    },
    simulation: {
      costProduct: myCostProduct,
      salePrice: mySalePrice,
      exposure: myExposure,
      weightCategory: myWeightCategory,
      reputation: myReputation,
      shippingFree: myShippingFree,
      sellerPaysFreight: sellerPaysFreight,
      shippingCostSellerEntered: myShippingCostSellerEntered,
      shippingCostApplied: myFreightApplied,
      shippingCostSource: myFreightSource,
      suggestedShippingFree,
      feePct: myFeePct,
      feeValue: myFeeValue,
      totalCost: myTotalCost,
      netProfit: myNetProfit,
      marginPct: myMarginPct
    },
    comparison: {
      priceDifference,
      priceDifferencePct
    },
    diagnosis: {
      demand,
      margin,
      price: pricePosition,
      decision,
      recommendation
    }
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    message: "Servidor funcionando - Versão 1.6",
    version: "1.6"
  });
});

app.get("/api/config", (req, res) => {
  res.json(CONFIG);
});

app.post("/api/reference/extract", async (req, res) => {
  try {
    const input = String(req.body?.input || "").trim();

    if (!input) {
      return res.status(400).json({
        ok: false,
        message: "Informe uma URL ou ID do anúncio."
      });
    }

    if (/^https?:\/\//i.test(input) && !isMercadoLivreUrl(input)) {
      return res.status(400).json({
        ok: false,
        message: "Use uma URL do Mercado Livre."
      });
    }

    const result = await extractReferencePublicData(input);
    return res.status(result.ok ? 200 : 422).json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || "Erro ao extrair dados públicos."
    });
  }
});

app.post("/api/analyze", (req, res) => {
  try {
    const reference = req.body?.reference || {};
    const simulation = req.body?.simulation || {};

    if (!reference.title && !reference.link && !reference.price) {
      return res.status(400).json({
        ok: false,
        message: "Preencha ao menos preço ou dados básicos do produto de referência."
      });
    }

    if (simulation.costProduct == null || simulation.salePrice == null) {
      return res.status(400).json({
        ok: false,
        message: "Preencha custo do produto e preço de venda."
      });
    }

    const analysis = calculateAnalysis(reference, simulation);

    return res.json({
      ok: true,
      analysis,
      version: "1.6"
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || "Erro ao calcular análise."
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor Validador ML V1.6 rodando em http://localhost:${PORT}`);
  console.log(`📊 Configurações atuais:`);
  console.log(`   - Frete grátis a partir de: R$ ${CONFIG.freightFreeThreshold}`);
  console.log(`   - Taxa Clássico: ${CONFIG.classicFeePct}%`);
  console.log(`   - Taxa Premium: ${CONFIG.premiumFeePct}%`);
  console.log(`   - Frete dinâmico: ${CONFIG.dynamicShippingEnabled ? "✅ Ativado" : "❌ Desativado"}`);
  console.log(`   - Pesos: Leve(R$${CONFIG.weightBaseLeve}) | Médio(R$${CONFIG.weightBaseMedio}) | Pesado(R$${CONFIG.weightBasePesado}) | Muito Pesado(R$${CONFIG.weightBaseMuitoPesado})`);
  console.log(`   - Prioridade frete: Manual > Automático`);
  console.log(`   - Lógica frete: Checkbox = Vendedor paga frete`);
});