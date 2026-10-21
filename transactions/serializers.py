from rest_framework import serializers

from .models import Transaction


class TransactionSerializer(serializers.ModelSerializer):
    """Serializer for personal financial transaction records.

    The owner is always set from the authenticated request and cannot be
    supplied by the client. Creation and automatic timestamps are read-only.
    """

    owner = serializers.PrimaryKeyRelatedField(read_only=True)

    class Meta:
        model = Transaction
        fields = [
            "id",
            "description",
            "activity_type",
            "amount",
            "currency",
            "activity_date",
            "owner",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["owner", "created_at", "updated_at"]

    def validate_amount(self, value):
        if value is None or value <= 0:
            raise serializers.ValidationError("Amount must be greater than zero.")
        return value