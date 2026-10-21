from datetime import date

from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .services import calculate_user_summary
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