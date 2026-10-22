import axios, { AxiosInstance } from "axios";

export interface DjangoUserSummary {
  currency: string;
  income_total: string;
  expense_total: string;
  refund_total: string;
  loan_received_total: string;
  loan_repayment_total: string;
  net_cash_flow: string;
  income_count: number;
  expense_count: number;
  refund_count: number;
  loan_received_count: number;
  loan_repayment_count: number;
  transfer_count: number;
}

export interface DjangoTransaction {
  id: number;
  description: string;
  activity_type: string;
  category: string;
  amount: string;
  currency: string;
  activity_date: string;
  owner: number;
  created_at: string;
  updated_at: string;
  is_voided: boolean;
  voided_at: string | null;
}

export interface PendingAction {
  action_type: "TRANSACTION" | "CORRECTION" | "CORRECTION_SELECT" | "DELETE_CONFIRM" | "UNDO_CONFIRM" | "ACCOUNT_DELETE_CONFIRM";
  payload: Record<string, any>;
  original_message_id?: string;
  expires_at?: string;
}

export interface ActiveCountry {
  name: string;
  country_code: string;
  currency_code: string;
  currency_name: string;
}

export interface OnboardingStatus {
  registered: boolean;
  preferred_name?: string;
  needs_name?: boolean;
  needs_country?: boolean;
  country_code?: string | null;
  currency_code?: string | null;
  time_zone?: string;
}

export function isUnknownWhatsAppPhoneResponse(status: unknown, detail: unknown): boolean {
  return (status === 401 || status === 403) && detail === "Unknown WhatsApp phone number.";
}

export class DjangoApiClient {
  private readonly client: AxiosInstance;

  constructor(baseURL: string, serviceKey: string) {
    if (!baseURL || !baseURL.startsWith("http")) {
      throw new Error("DJANGO_BASE_URL must be set to an HTTP URL before starting the WhatsApp service.");
    }

    if (!serviceKey) {
      throw new Error("DJANGO_SERVICE_KEY is required to authenticate with Django.");
    }

    this.client = axios.create({
      baseURL,
      headers: {
        "X-Service-Key": serviceKey,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });
  }

  /**
   * Resolve a WhatsApp phone number to a Django user by calling the
   * transactions list endpoint. If the phone number is unknown, the
   * service key authentication may report the backend's unknown-phone detail
   * with either 401 or 403, depending on Django authentication negotiation.
   */
  async resolvePhone(phoneNumber: string): Promise<boolean> {
    try {
      await this.client.get("/api/v1/transactions/", {
        headers: { "X-WhatsApp-Phone": phoneNumber },
      });
      return true;
    } catch (error: any) {
      // Only the exact allowlisted detail means the number is unregistered.
      // A generic 401/403 (including invalid service credentials) must still
      // fail closed and must never trigger onboarding.
      if (isUnknownWhatsAppPhoneResponse(error.response?.status, error.response?.data?.detail)) {
        return false;
      }
      throw error;
    }
  }

  async saveWhatsAppProfile(phoneNumber: string, preferredName: string): Promise<{ created: boolean }> {
    const response = await this.client.post("/api/v1/onboarding/", {
      phone_number: phoneNumber,
      preferred_name: preferredName,
    });
    return response.data;
  }

  async saveWhatsAppCountry(phoneNumber: string, countryCode: string): Promise<{ created: boolean }> {
    const response = await this.client.post("/api/v1/onboarding/", {
      phone_number: phoneNumber,
      country_code: countryCode,
    });
    return response.data;
  }

  async getOnboardingStatus(phoneNumber: string): Promise<OnboardingStatus> {
    const response = await this.client.get("/api/v1/onboarding/status/", {
      headers: { "X-WhatsApp-Phone": phoneNumber },
    });
    return response.data;
  }

  async getActiveCountries(): Promise<ActiveCountry[]> {
    const response = await this.client.get("/api/v1/countries/");
    return response.data;
  }

  async recordTransaction(phoneNumber: string, payload: {
    description: string;
    activity_type: "INCOME" | "EXPENSE" | "REFUND" | "LOAN_RECEIVED" | "LOAN_REPAYMENT" | "TRANSFER";
    category: string;
    amount: string;
    currency: string;
    activity_date: string;
  }, messageId?: string): Promise<DjangoTransaction> {
    const response = await this.client.post(
      "/api/v1/transactions/",
      payload,
      {
        headers: {
          "X-WhatsApp-Phone": phoneNumber,
          ...(messageId ? { "X-WhatsApp-Message-ID": messageId } : {}),
        },
      }
    );
    return response.data;
  }

  async getTransactions(phoneNumber: string, search = "", recent = false, amount = ""): Promise<DjangoTransaction[]> {
    const response = await this.client.get("/api/v1/transactions/", {
      params: { ...(search ? { search } : {}), ...(recent ? { recent: "1" } : {}), ...(amount ? { amount } : {}) },
      headers: { "X-WhatsApp-Phone": phoneNumber },
    });
    return Array.isArray(response.data.results) ? response.data.results : response.data;
  }

  async updateTransaction(phoneNumber: string, id: number, changes: Record<string, unknown>): Promise<DjangoTransaction> {
    const response = await this.client.patch(`/api/v1/transactions/${id}/`, changes, {
      headers: { "X-WhatsApp-Phone": phoneNumber },
    });
    return response.data;
  }

  async voidTransaction(phoneNumber: string, id: number, reason: "UNDO" | "DELETE", messageId: string): Promise<DjangoTransaction> {
    const response = await this.client.post(`/api/v1/transactions/${id}/void/`, { reason }, {
      headers: {
        "X-WhatsApp-Phone": phoneNumber,
        "X-WhatsApp-Message-ID": messageId,
      },
    });
    return response.data;
  }

  async getPendingAction(phoneNumber: string): Promise<PendingAction | null> {
    const response = await this.client.get("/api/v1/pending-action/", {
      headers: { "X-WhatsApp-Phone": phoneNumber },
    });
    return response.data.pending || null;
  }

  async savePendingAction(phoneNumber: string, actionType: PendingAction["action_type"], payload: Record<string, any>, messageId: string): Promise<void> {
    await this.client.post("/api/v1/pending-action/", {
      action_type: actionType,
      payload,
      original_message_id: messageId,
    }, { headers: { "X-WhatsApp-Phone": phoneNumber } });
  }

  async clearPendingAction(phoneNumber: string): Promise<void> {
    await this.client.delete("/api/v1/pending-action/", {
      headers: { "X-WhatsApp-Phone": phoneNumber },
    });
  }

  async getSummary(phoneNumber: string, startDate: string, endDate: string): Promise<DjangoUserSummary[]> {
    const response = await this.client.get("/api/v1/summaries/", {
      params: { start_date: startDate, end_date: endDate },
      headers: { "X-WhatsApp-Phone": phoneNumber },
    });
    return response.data;
  }

  async getFinancialInsights(phoneNumber: string, params: {
    start_date: string; end_date: string; compare_start_date?: string; compare_end_date?: string;
    search?: string; category?: string;
  }): Promise<any> {
    const response = await this.client.get("/api/v1/insights/", {
      params,
      headers: { "X-WhatsApp-Phone": phoneNumber },
    });
    return response.data;
  }

  async deleteAccountData(phoneNumber: string, messageId: string): Promise<void> {
    await this.client.delete("/api/v1/account/data/", {
      headers: { "X-WhatsApp-Phone": phoneNumber, "X-WhatsApp-Message-ID": messageId },
    });
  }

  async healthCheck(): Promise<{ status: string }> {
    const response = await this.client.get("/api/v1/health/");
    return response.data;
  }
}
