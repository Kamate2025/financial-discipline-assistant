from rest_framework import serializers


class CurrencySummarySerializer(serializers.Serializer):
    """Serializer for a single currency's financial summary."""

    currency = serializers.CharField()
    income_total = serializers.DecimalField(max_digits=12, decimal_places=2)
    expense_total = serializers.DecimalField(max_digits=12, decimal_places=2)
    refund_total = serializers.DecimalField(max_digits=12, decimal_places=2)
    loan_received_total = serializers.DecimalField(max_digits=12, decimal_places=2)
    loan_repayment_total = serializers.DecimalField(max_digits=12, decimal_places=2)
    net_cash_flow = serializers.DecimalField(max_digits=12, decimal_places=2)
    income_count = serializers.IntegerField()
    expense_count = serializers.IntegerField()
    refund_count = serializers.IntegerField()
    loan_received_count = serializers.IntegerField()
    loan_repayment_count = serializers.IntegerField()
    transfer_count = serializers.IntegerField()
