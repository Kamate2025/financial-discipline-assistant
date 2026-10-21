from django.contrib import admin

from .models import Transaction, UserProfile


@admin.register(Transaction)
class TransactionAdmin(admin.ModelAdmin):
    list_display = (
        "description",
        "activity_type",
        "amount",
        "currency",
        "activity_date",
        "owner",
        "created_at",
    )
    list_filter = ("activity_type", "currency", "activity_date", "created_at")
    search_fields = ("description", "owner__username")


@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    list_display = ("user", "phone_number", "preferred_name", "created_at")
    list_filter = ("created_at", "updated_at")
    search_fields = ("user__username", "phone_number", "preferred_name")
    readonly_fields = ("created_at", "updated_at")
