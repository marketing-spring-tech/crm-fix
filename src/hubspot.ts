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

  /**
   * Reads contacts by a unique property (e.g. email or mixpanel_user_id), chunked by 100.
   * Returns a map keyed by that property's value; ids with no contact are absent.
   */
  async readContactsBy(idProperty: string, ids: string[], properties: string[]): Promise<Map<string, Contact>> {
    const out = new Map<string, Contact>();
    for (const chunk of chunks(ids, 100)) {
      const res = await this.request<{ results: Contact[] }>("POST", "/crm/v3/objects/contacts/batch/read", {
        idProperty,
        properties: [...properties, idProperty],
        inputs: chunk.map((id) => ({ id })),
      });
      for (const c of res.results ?? []) {
        const key = c.properties[idProperty];
        if (key) out.set(idProperty === "email" ? key.toLowerCase() : key, c);
      }
    }
    return out;
  }

  /** Updates contacts by HubSpot record id, chunked by 100. */
  async updateContacts(inputs: { id: string; properties: Record<string, string> }[]): Promise<void> {
    for (const chunk of chunks(inputs, 100)) {
      await this.request("POST", "/crm/v3/objects/contacts/batch/update", { inputs: chunk });
    }
  }

  /** Create-or-update contacts keyed on email (any count; chunked by 100). */
  async upsertContactsByEmail(
    inputs: { email: string; properties: Record<string, string> }[],
  ): Promise<Contact[]> {
    const out: Contact[] = [];
    for (const chunk of chunks(inputs, 100)) {
      const res = await this.request<{ results: Contact[] }>("POST", "/crm/v3/objects/contacts/batch/upsert", {
        inputs: chunk.map((i) => ({
          idProperty: "email",
          id: i.email,
          properties: { ...i.properties, email: i.email },
        })),
      });
      out.push(...res.results);
    }
    return out;
  }

  /** Creates timeline notes on contacts (chunked by 100). */
  async createNotes(notes: { contactId: string; body: string; timestamp: string }[]): Promise<void> {
    for (const chunk of chunks(notes, 100)) {
      await this.request("POST", "/crm/v3/objects/notes/batch/create", {
        inputs: chunk.map((n) => ({
          properties: { hs_note_body: n.body, hs_timestamp: n.timestamp },
          associations: [
            {
              to: { id: n.contactId },
              types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_CONTACT_ASSOCIATION }],
            },
          ],
        })),
      });
    }
  }

  /** Custom behavioral events (Marketing Hub Enterprise). */
  async sendCustomEvent(eventName: string, contactId: string, occurredAt: string): Promise<void> {
    await this.request("POST", "/events/v3/send", { eventName, objectId: contactId, occurredAt, properties: {} });
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
    hasUniqueValue?: boolean;
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

export function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
