const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  whatsapp: {
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: env.WHATSAPP_APP_SECRET || '',
    apiVersion: env.GRAPH_API_VERSION || 'v23.0',
  },
  shop: {
    name: env.SHOP_NAME || 'AIMAG ELECTRIC',
    currency: env.CURRENCY || '₸',
    phone: env.SHOP_PHONE || '+7 705 615-17-17',
    hours: env.SHOP_HOURS || 'Пн–Пт, 09:00–18:00',
    managerPhone: env.MANAGER_PHONE || '',
  },
  ai: {
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  },
  dbPath: env.DB_PATH || new URL('../data/db.json', import.meta.url).pathname,
  shopInfoPath: env.SHOP_INFO_PATH || new URL('../data/shop-info.md', import.meta.url).pathname,
  catalogPath: env.CATALOG_PATH || new URL('../data/catalog.json', import.meta.url).pathname,
};
