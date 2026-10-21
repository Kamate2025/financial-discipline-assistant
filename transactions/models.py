from decimal import Decimal

import re
from django.conf import settings
from django.core.validators import MinValueValidator
from django.db import models


class Transaction(models.Model):
    """A single personal financial record.

    The activity type distinguishes money coming in (income), money going out
    (expense), and movement between a user's own accounts (transfer). Borrowed
    money and loan repayments are not modelled as separate types in this first
    version because they are neither income nor expense and are not transfers
    between a user's own accounts; representing them here would risk misleading
    financial summaries. They are documented as a future design decision.
    """

    class ActivityType(models.TextChoices):
        INCOME = "INCOME", "Income"
        EXPENSE = "EXPENSE", "Expense"
        TRANSFER = "TRANSFER", "Transfer"

    description = models.CharField(max_length=255)
    activity_type = models.CharField(max_length=20, choices=ActivityType.choices)
    amount = models.DecimalField(
        max_digits=12,
        decimal_places=2,
        validators=[MinValueValidator(Decimal("0.01"))],
        help_text="Must be greater than zero.",
    )
    currency = models.CharField(max_length=3, default="UGX")
    activity_date = models.DateField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="transactions",
    )

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(amount__gt=0),
                name="transactions_amount_positive",
            )
        ]
        ordering = ["-activity_date", "-created_at"]

    def __str__(self):
        return f"{self.description} - {self.amount} {self.currency}"


def normalize_phone_number(value):
    """Normalize a WhatsApp phone number to a consistent international format.

    Removes spaces, dashes, parentheses, and dots. Handles a leading single
    zero as a Ugandan local number (replacing it with the +256 country code)
    and a leading double-zero international prefix as a plus sign. Ensures the
    number starts with a plus sign. Returns the normalized string, or the
    original value if it is empty.
    """
    if not value:
        return value
    normalized = value.strip()
    # Replace a leading double-zero international prefix with a plus sign.
    if normalized.startswith("00"):
        normalized = "+" + normalized[2:]
    # Replace a leading single zero (Ugandan local format) with +256.
    elif normalized.startswith("0"):
        normalized = "+256" + normalized[1:]
    # Remove all remaining spaces, dashes, parentheses, and dots.
    normalized = re.sub(r"[\s\-\(\)\.]", "", normalized)
    # Ensure a leading plus sign.
    if normalized and not normalized.startswith("+"):
        normalized = "+" + normalized
    return normalized


class UserProfile(models.Model):
    """Links a Django user to a normalized WhatsApp phone number and preferred name.

    The phone number is the external identity key used to recognize returning
    WhatsApp users. It is unique but is deliberately not the primary key, so a
    user can update their phone number if needed without rebuilding the record.
    The preferred name is stored separately from the phone number and can be
    changed at any time, including through a future conversational request.
    """

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="profile",
    )
    phone_number = models.CharField(
        max_length=20,
        unique=True,
        help_text="Normalized WhatsApp phone number in international format.",
    )
    preferred_name = models.CharField(
        max_length=100,
        blank=True,
        default="",
        help_text="The user's preferred display name, separate from the phone number.",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(phone_number__gt=""),
                name="userprofile_phone_number_non_empty",
            )
        ]
        ordering = ["-created_at"]

    def clean(self):
        super().clean()
        self.phone_number = normalize_phone_number(self.phone_number)

    def save(self, *args, **kwargs):
        self.phone_number = normalize_phone_number(self.phone_number)
        super().save(*args, **kwargs)

    @classmethod
    def lookup_by_phone_number(cls, phone_number):
        """Return the profile matching the normalized phone number, or None."""
        normalized = normalize_phone_number(phone_number)
        return cls.objects.filter(phone_number=normalized).first()

    def __str__(self):
        return f"{self.user.username} - {self.phone_number}"


class ProcessedMessage(models.Model):
    """Records WhatsApp message IDs that have already been processed.

    Prevents duplicate transaction creation when WhatsApp retries message
    delivery, the service reconnects, or an API request times out after the
    transaction has already been saved.
    """

    message_id = models.CharField(max_length=255, unique=True)
    processed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-processed_at"]

    def __str__(self):
        return self.message_id
