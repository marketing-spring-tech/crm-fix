export type FetchFn = typeof fetch;

export class HubSpotError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

export interface Contact {
  id: string;
  properties: Record<string, string | null>;
}

const NOTE_TO_CONTACT_ASSOCIATION = 202;

/** Minimal HubSpot CRM v3 client with retry on 429/5xx. */
export class HubSpotClient {
  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly baseUrl = "https://api.hubapi.com",
    private readonly maxRetries = 4,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      let parsed: unknown;
      const text = await res.text();
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      throw new HubSpotError(`HubSpot ${method} ${path} failed with ${res.status}`, res.status, parsed);
    }
  }

  /** Returns null when no contact has that email. */
  async getContactByEmail(email: string, properties: string[]): Promise<Contact | null> {
    const qs = new URLSearchParams({ idProperty: "email", properties: properties.join(",") });
    try {
      return await this.request<Contact>("GET", `/crm/v3/objects/contacts/${encodeURIComponent(email)}?${qs}`);
    } catch (err) {
      if (err instanceof HubSpotError && err.status === 404) return null;
      throw err;
    }
  }

  /** Create-or-update contacts keyed on email (max 100 per call). */
  async upsertContactsByEmail(
    inputs: { email: string; properties: Record<string, string> }[],
  ): Promise<Contact[]> {
    if (inputs.length === 0) return [];
    const res = await this.request<{ results: Contact[] }>("POST", "/crm/v3/objects/contacts/batch/upsert", {
      inputs: inputs.map((i) => ({
        idProperty: "email",
        id: i.email,
        properties: { ...i.properties, email: i.email },
      })),
    });
    return res.results;
  }

  async createNoteOnContact(contactId: string, body: string, timestamp: string): Promise<void> {
    await this.request("POST", "/crm/v3/objects/notes", {
      properties: { hs_note_body: body, hs_timestamp: timestamp },
      associations: [
        {
          to: { id: contactId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_CONTACT_ASSOCIATION }],
        },
      ],
    });
  }

  /** Custom behavioral events (Marketing Hub Enterprise). */
  async sendCustomEvent(
    eventName: string,
    email: string,
    occurredAt: string,
    properties: Record<string, string>,
  ): Promise<void> {
    await this.request("POST", "/events/v3/send", { eventName, email, occurredAt, properties });
  }

  async ensurePropertyGroup(name: string, label: string): Promise<"created" | "exists"> {
    try {
      await this.request("POST", "/crm/v3/properties/contacts/groups", { name, label, displayOrder: -1 });
      return "created";
    } catch (err) {
      if (err instanceof HubSpotError && err.status === 409) return "exists";
      throw err;
    }
  }

  async ensureProperty(def: {
    name: string;
    label: string;
    type: "datetime" | "number" | "string";
    fieldType: "date" | "number" | "text";
    groupName: string;
    description?: string;
  }): Promise<"created" | "exists"> {
    try {
      await this.request("POST", "/crm/v3/properties/contacts", def);
      return "created";
    } catch (err) {
      if (err instanceof HubSpotError && err.status === 409) return "exists";
      throw err;
    }
  }
}
