from django.urls import path

from .health_views import HealthView
from .summary_views import UserSummaryView
from .views import TransactionListCreateView, TransactionRetrieveUpdateDestroyView, WhatsAppOnboardingView

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
        "summaries/",
        UserSummaryView.as_view(),
        name="user-summary",
    ),
    path(
        "health/",
        HealthView.as_view(),
        name="health",
    ),
    path(
        "onboarding/",
        WhatsAppOnboardingView.as_view(),
        name="whatsapp-onboarding",
    ),
]
