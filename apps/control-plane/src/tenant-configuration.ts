export type TenantConfiguration = {
  tenantId: string;
  business: {
    displayName: string;
  };
  assistant: {
    name: string;
    greeting: string;
  };
  tools: {
    allowed: string[];
  };
};

const TENANTS: Record<string, TenantConfiguration> = {
  "clinica-estetica-madrid": {
    tenantId: "clinica-estetica-madrid",
    business: {
      displayName: "Clínica Estética Madrid",
    },
    assistant: {
      name: "Carolina",
      greeting: "Buenas, soy Carolina, asistente virtual de la Clínica Estética Madrid. ¿En qué puedo ayudarte?",
    },
    tools: {
      allowed: ["get_business_information"],
    },
  },
};

export function getTenantConfiguration(tenantId: string): TenantConfiguration | null {
  return TENANTS[tenantId] ?? null;
}
