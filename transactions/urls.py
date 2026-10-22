from django.urls import path

from .health_views import HealthView
from .summary_views import FinancialInsightsView, UserSummaryView
from .views import (
    AccountDataDeleteView,
    ActiveCountriesView,
    PendingActionView,
    TransactionListCreateView,
    TransactionRetrieveUpdateDestroyView,
    TransactionVoidView,
    WhatsAppOnboardingStatusView,
    WhatsAppOnboardingView,
)

urlpatterns = [
    path(
        "transactions/",
        TransactionListCreateView.as_view(),
        name="transaction-list-create",
    ),
    path(
        "transactions/<int:pk>/",
        TransactionRetrieveUpdateDestroyView.as_view(),
        name="transaction-retrieve",
    ),
    path(
        "transactions/<int:pk>/void/",
        TransactionVoidView.as_view(),
        name="transaction-void",
    ),
    path(
        "summaries/",
        UserSummaryView.as_view(),
        name="user-summary",
    ),
    path("insights/", FinancialInsightsView.as_view(), name="financial-insights"),
    path(
        "health/",
        HealthView.as_view(),
        name="health",
    ),
    path(
        "countries/",
        ActiveCountriesView.as_view(),
        name="active-countries",
    ),
    path(
        "onboarding/",
        WhatsAppOnboardingView.as_view(),
        name="whatsapp-onboarding",
    ),
    path(
        "onboarding/status/",
        WhatsAppOnboardingStatusView.as_view(),
        name="whatsapp-onboarding-status",
    ),
    path("pending-action/", PendingActionView.as_view(), name="pending-action"),
    path("account/data/", AccountDataDeleteView.as_view(), name="account-data-delete"),
]
