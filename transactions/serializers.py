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
            "category",
            "amount",
            "currency",
            "activity_date",
            "owner",
            "created_at",
            "updated_at",
            "is_voided",
            "voided_at",
        ]
        read_only_fields = ["owner", "created_at", "updated_at", "is_voided", "voided_at"]

    def validate_amount(self, value):
        if value is None or value <= 0:
            raise serializers.ValidationError("Amount must be greater than zero.")
        return value

    def validate_activity_type(self, value):
        # Keep historical transfer rows readable/editable, but stop creating
        # new transfers through the API.
        if value == Transaction.ActivityType.TRANSFER and self.instance is None:
            raise serializers.ValidationError("New transfer entries are not supported.")
        return value
