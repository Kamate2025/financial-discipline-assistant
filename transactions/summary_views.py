from datetime import date
import re

from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .services import calculate_financial_insights, calculate_user_summary
from .summary_serializers import CurrencySummarySerializer


class UserSummaryView(APIView):
    """Retrieve a financial summary for the authenticated user.

    Query parameters:
        start_date — required, YYYY-MM-DD (inclusive)
        end_date   — required, YYYY-MM-DD (inclusive)

    Returns a list of summaries, one per currency used by the user within
    the date range. Transfers are counted separately and excluded from
    income, expense, and net cash flow totals.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        start_date_str = request.query_params.get("start_date")
        end_date_str = request.query_params.get("end_date")

        if not start_date_str or not end_date_str:
            return Response(
                {"error": "Both start_date and end_date are required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            start_date = date.fromisoformat(start_date_str)
            end_date = date.fromisoformat(end_date_str)
        except (ValueError, TypeError):
            return Response(
                {"error": "Dates must be in YYYY-MM-DD format."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if start_date > end_date:
            return Response(
                {"error": "start_date must not be after end_date."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        summaries = calculate_user_summary(request.user, start_date, end_date)
        serializer = CurrencySummarySerializer(summaries, many=True)
        return Response(serializer.data)


class FinancialInsightsView(APIView):
    """Return deterministic summaries, transaction matches, and comparisons."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        values = {
            "start_date": request.query_params.get("start_date"),
            "end_date": request.query_params.get("end_date"),
            "compare_start_date": request.query_params.get("compare_start_date"),
            "compare_end_date": request.query_params.get("compare_end_date"),
        }
        if not values["start_date"] or not values["end_date"]:
            return Response({"error": "start_date and end_date are required."}, status=status.HTTP_400_BAD_REQUEST)
        if bool(values["compare_start_date"]) != bool(values["compare_end_date"]):
            return Response({"error": "Both comparison dates must be provided together."}, status=status.HTTP_400_BAD_REQUEST)
        if any(value and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) for value in values.values()):
            return Response({"error": "Dates must use YYYY-MM-DD format."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            start, end = date.fromisoformat(values["start_date"]), date.fromisoformat(values["end_date"])
            compare_start = date.fromisoformat(values["compare_start_date"]) if values["compare_start_date"] else None
            compare_end = date.fromisoformat(values["compare_end_date"]) if values["compare_end_date"] else None
        except (TypeError, ValueError):
            return Response({"error": "Dates must use YYYY-MM-DD format."}, status=status.HTTP_400_BAD_REQUEST)
        if start > end or (compare_start and compare_end and compare_start > compare_end):
            return Response({"error": "Date ranges must be ordered from start to end."}, status=status.HTTP_400_BAD_REQUEST)
        search = request.query_params.get("search", "").strip()
        category = request.query_params.get("category", "").strip().upper()
        if len(search) > 200 or len(category) > 20:
            return Response({"error": "Search and category filters are too long."}, status=status.HTTP_400_BAD_REQUEST)
        data = calculate_financial_insights(request.user, start, end, compare_start, compare_end, search, category)
        return Response(data)
