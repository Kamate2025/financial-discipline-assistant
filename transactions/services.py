from datetime import date
from decimal import Decimal, InvalidOperation

from django.core.exceptions import ValidationError

from .models import Transaction, UserProfile


class FinancialSummary:
    """Result of a financial summary calculation for a single currency.

    Transfers are counted separately and are excluded from income totals,
    expense totals, and net cash flow.
    """

    def __init__(self, currency):
        self.currency = currency
        self.income_total = Decimal("0.00")
        self.expense_total = Decimal("0.00")
        self.income_count = 0
        self.expense_count = 0
        self.transfer_count = 0

    @property
    def net_cash_flow(self):
        return self.income_total - self.expense_total


def calculate_user_summary(user, start_date, end_date):
    """Calculate financial summaries for a user within an inclusive date range.

    Returns a list of FinancialSummary objects, one per currency found in the
    user's transactions within the range. Every calculation is filtered by
    ownership, so another user's transactions are never included. Transfers
    are counted separately and excluded from income, expenses, and net cash
    flow. When no transactions exist for a currency, the totals and counts
    are zero.

    Raises ValueError if start_date is after end_date.
    """
    if start_date > end_date:
        raise ValueError("start_date must not be after end_date")

    transactions = Transaction.objects.filter(
        owner=user,
        activity_date__gte=start_date,
        activity_date__lte=end_date,
    ).order_by("currency", "activity_type")

    summaries = {}
    for txn in transactions:
        currency = txn.currency
        if currency not in summaries:
            summaries[currency] = FinancialSummary(currency)

        summary = summaries[currency]
        if txn.activity_type == Transaction.ActivityType.INCOME:
            summary.income_total += txn.amount
            summary.income_count += 1
        elif txn.activity_type == Transaction.ActivityType.EXPENSE:
            summary.expense_total += txn.amount
            summary.expense_count += 1
        elif txn.activity_type == Transaction.ActivityType.TRANSFER:
            summary.transfer_count += 1

    return sorted(summaries.values(), key=lambda s: s.currency)


class TransactionRecordingError(Exception):
    """Raised when a transaction cannot be recorded due to invalid input."""

    def __init__(self, message, field=None):
        super().__init__(message)
        self.message = message
        self.field = field


def record_transaction(user, description, activity_type, amount, currency="UGX", activity_date=None):
    """Record a financial transaction for a user.

    This is the single reusable entry point for creating transactions, used by
    both the API views and the WhatsApp integration. All validation rules from
    the Transaction model are enforced.

    Args:
        user: The Django user who owns the transaction.
        description: Description of the financial activity.
        activity_type: One of INCOME, EXPENSE, or TRANSFER.
        amount: Positive monetary amount (string, Decimal, or number).
        currency: Currency code, defaults to UGX.
        activity_date: Date the activity occurred, defaults to today.

    Returns:
        The created Transaction instance.

    Raises:
        TransactionRecordingError: If any input is invalid.
    """
    if not user or not user.pk:
        raise TransactionRecordingError("A valid owner is required.")

    if not description or not description.strip():
        raise TransactionRecordingError("Description is required.", field="description")

    valid_types = {c.value for c in Transaction.ActivityType}
    if activity_type not in valid_types:
        raise TransactionRecordingError(
            f"Unsupported activity type '{activity_type}'. Supported types: {', '.join(sorted(valid_types))}.",
            field="activity_type",
        )

    try:
        amount_decimal = Decimal(str(amount))
    except (InvalidOperation, ValueError, TypeError):
        raise TransactionRecordingError("Amount must be a valid number.", field="amount")

    if amount_decimal <= 0:
        raise TransactionRecordingError("Amount must be greater than zero.", field="amount")

    if not currency or len(currency) > 3:
        raise TransactionRecordingError("Currency must be a valid code of up to 3 characters.", field="currency")

    if activity_date is None:
        activity_date = date.today()
    elif isinstance(activity_date, str):
        activity_date = date.fromisoformat(activity_date)

    txn = Transaction(
        owner=user,
        description=description.strip(),
        activity_type=activity_type,
        amount=amount_decimal,
        currency=currency.upper(),
        activity_date=activity_date,
    )
    txn.full_clean()
    txn.save()
    return txn


def resolve_user_by_phone(phone_number):
    """Resolve a normalized WhatsApp phone number to its Django user.

    Returns the user, or None if no profile matches.
    """
    profile = UserProfile.lookup_by_phone_number(phone_number)
    return profile.user if profile else None