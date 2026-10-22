import hashlib
import hmac
import re
from datetime import timedelta

from django.conf import settings
from django.db import IntegrityError, models, transaction
from django.utils import timezone
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from django.contrib.auth import get_user_model

from .models import Country, PendingAction, ProcessedMessage, Transaction, UserProfile, normalize_phone_number
from .serializers import TransactionSerializer


class TransactionListCreateView(generics.ListCreateAPIView):
    """List the authenticated user's transactions or create a new one.

    Ownership is always assigned from the authenticated user, never from the
    request payload. Users can only see and create their own records.
    """

    serializer_class = TransactionSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        queryset = Transaction.objects.filter(owner=self.request.user, is_voided=False)
        query = self.request.query_params.get("search", "").strip()
        if query:
            queryset = queryset.filter(
                models.Q(description__icontains=query)
                | models.Q(category__icontains=query)
            )
        amount = self.request.query_params.get("amount")
        if amount:
            if not re.fullmatch(r"\d{1,10}(?:\.\d{1,2})?", amount):
                return queryset.none()
            queryset = queryset.filter(amount=amount)
        if self.request.query_params.get("recent") == "1":
            queryset = queryset.order_by("-created_at", "-pk")
        return queryset

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    def create(self, request, *args, **kwargs):
        message_id = request.headers.get("X-WhatsApp-Message-ID")
        if message_id is None:
            return super().create(request, *args, **kwargs)
        if not message_id.strip() or len(message_id) > 255:
            return Response(
                {"detail": "Invalid WhatsApp message identifier."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            with transaction.atomic():
                existing = ProcessedMessage.objects.select_related("transaction").filter(
                    message_id=message_id
                ).first()
                if existing:
                    return self._existing_message_response(existing, request.user.pk)

                serializer = self.get_serializer(data=request.data)
                serializer.is_valid(raise_exception=True)
                self.perform_create(serializer)
                ProcessedMessage.objects.create(
                    message_id=message_id,
                    transaction=serializer.instance,
                )
                headers = self.get_success_headers(serializer.data)
                return Response(serializer.data, status=status.HTTP_201_CREATED, headers=headers)
        except IntegrityError:
            # A concurrent redelivery can race the unique message-id insert.
            existing = ProcessedMessage.objects.select_related("transaction").filter(
                message_id=message_id
            ).first()
            if existing:
                return self._existing_message_response(existing, request.user.pk)
            raise

    @staticmethod
    def _existing_message_response(processed, owner_id):
        saved = processed.transaction
        if saved is None or saved.owner_id != owner_id:
            return Response(
                {"detail": "This message was already processed; no result can be returned."},
                status=status.HTTP_409_CONFLICT,
            )
        return Response(TransactionSerializer(saved).data, status=status.HTTP_200_OK)


class TransactionRetrieveUpdateDestroyView(generics.RetrieveUpdateDestroyAPIView):
    """Retrieve, update, or delete a single transaction belonging to the authenticated user.

    Ownership and automatic timestamps are protected from client modification.
    Users can only modify or delete their own records; access to another user's
    record returns a 404 response.
    """

    serializer_class = TransactionSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return Transaction.objects.filter(owner=self.request.user)

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        instance.is_voided = True
        instance.voided_at = timezone.now()
        instance.void_reason = "DELETE"
        instance.save(update_fields=["is_voided", "voided_at", "void_reason", "updated_at"])
        return Response(TransactionSerializer(instance).data, status=status.HTTP_200_OK)


class WhatsAppOnboardingView(APIView):
    """Create/update the name first, then apply an active configured country."""

    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        supplied_key = request.headers.get("X-Service-Key", "")
        expected_key = settings.DJANGO_SERVICE_KEY
        if not expected_key or not hmac.compare_digest(supplied_key, expected_key):
            return Response({"detail": "Invalid service credential."}, status=status.HTTP_403_FORBIDDEN)

        phone = request.data.get("phone_number", "")
        name = request.data.get("preferred_name")
        country_code = request.data.get("country_code")
        if not isinstance(phone, str) or not re.fullmatch(r"\+?\d{7,20}", phone):
            return Response({"phone_number": "Enter a valid international phone number."}, status=status.HTTP_400_BAD_REQUEST)
        if name is not None and (not isinstance(name, str) or not name.strip() or len(name.strip()) > 100):
            return Response({"preferred_name": "Enter a name of 1 to 100 characters."}, status=status.HTTP_400_BAD_REQUEST)
        if name is None and not country_code:
            return Response({"preferred_name": "A name is required to create a profile."}, status=status.HTTP_400_BAD_REQUEST)

        country = None
        if country_code is not None:
            if not isinstance(country_code, str):
                return Response({"country_code": "Select an available country code."}, status=status.HTTP_400_BAD_REQUEST)
            country = Country.objects.filter(
                country_code=country_code.strip().upper(),
                is_active=True,
                default_currency__is_active=True,
            ).prefetch_related("currencies").first()
            if country is None or not country.currencies.filter(
                pk=country.default_currency_id, is_active=True
            ).exists():
                return Response({"country_code": "Select an available country."}, status=status.HTTP_400_BAD_REQUEST)

        phone = normalize_phone_number(phone)
        profile = UserProfile.lookup_by_phone_number(phone)
        if profile:
            changed = ["updated_at"]
            if name is not None:
                profile.preferred_name = name.strip()
                changed.append("preferred_name")
            if country is not None:
                profile.country = country
                profile.preferred_currency = country.default_currency
                changed.extend(["country", "preferred_currency"])
            profile.save(update_fields=changed)
            return Response({"created": False}, status=status.HTTP_200_OK)

        # Keep WhatsApp phone numbers out of Django usernames and create no
        # password that could be used to log in through a separate channel.
        username = "wa_" + hashlib.sha256(phone.encode("utf-8")).hexdigest()
        try:
            with transaction.atomic():
                user = get_user_model().objects.create_user(username=username, password=None)
                UserProfile.objects.create(
                    user=user,
                    phone_number=phone,
                    preferred_name=name.strip(),
                    country=country,
                    preferred_currency=country.default_currency if country else None,
                )
        except IntegrityError:
            # Concurrent onboarding requests can race to create the same phone.
            profile = UserProfile.lookup_by_phone_number(phone)
            if profile is None:
                raise
            if name is not None:
                profile.preferred_name = name.strip()
            if country is not None:
                profile.country = country
                profile.preferred_currency = country.default_currency
            profile.save()
            return Response({"created": False}, status=status.HTTP_200_OK)
        return Response({"created": True}, status=status.HTTP_201_CREATED)


class ActiveCountriesView(APIView):
    """List only selectable countries; country metadata is not user data."""

    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        countries = Country.objects.filter(
            is_active=True,
            default_currency__is_active=True,
            currencies__is_active=True,
            currencies= models.F("default_currency"),
        ).distinct().order_by("name")
        return Response([
            {
                "name": country.name,
                "country_code": country.country_code,
                "currency_code": country.default_currency.code,
                "currency_name": country.default_currency.name,
            }
            for country in countries.select_related("default_currency")
        ])


class WhatsAppOnboardingStatusView(APIView):
    """Return the persisted registration step for an authenticated bridge sender."""

    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        supplied_key = request.headers.get("X-Service-Key", "")
        expected_key = settings.DJANGO_SERVICE_KEY
        if not expected_key or not hmac.compare_digest(supplied_key, expected_key):
            return Response({"detail": "Invalid service credential."}, status=status.HTTP_403_FORBIDDEN)
        phone = request.headers.get("X-WhatsApp-Phone", "")
        if not re.fullmatch(r"\+?\d{7,20}", phone):
            return Response({"detail": "Invalid WhatsApp phone number."}, status=status.HTTP_400_BAD_REQUEST)
        profile = UserProfile.objects.select_related(
            "country", "preferred_currency"
        ).filter(phone_number=normalize_phone_number(phone)).first()
        if profile is None:
            return Response({"registered": False})
        return Response({
            "registered": True,
            "preferred_name": profile.preferred_name,
            "needs_name": not bool(profile.preferred_name.strip()),
            "needs_country": (
                profile.country_id is None
                or profile.preferred_currency_id is None
                or not profile.country.is_active
                or not profile.preferred_currency.is_active
            ),
            "country_code": profile.country.country_code if profile.country_id else None,
            "currency_code": profile.preferred_currency.code if profile.preferred_currency_id else None,
            "time_zone": profile.country.time_zone if profile.country_id else "Africa/Kampala",
        })


class PendingActionView(APIView):
    """Read, replace, or clear one pending WhatsApp action for this user."""

    permission_classes = [permissions.IsAuthenticated]

    def _profile(self, request):
        return UserProfile.objects.filter(user=request.user).first()

    def get(self, request):
        profile = self._profile(request)
        if profile is None:
            return Response({"pending": None})
        pending = PendingAction.objects.filter(profile=profile).first()
        if pending is None:
            return Response({"pending": None})
        if pending.expires_at <= timezone.now():
            pending.delete()
            return Response({"pending": None})
        return Response({
            "pending": {
                "action_type": pending.action_type,
                "payload": pending.payload,
                "original_message_id": pending.original_message_id,
                "expires_at": pending.expires_at,
            }
        })

    def post(self, request):
        profile = self._profile(request)
        if profile is None:
            return Response({"detail": "WhatsApp profile not found."}, status=status.HTTP_404_NOT_FOUND)
        action_type = request.data.get("action_type")
        payload = request.data.get("payload", {})
        message_id = request.data.get("original_message_id", "")
        valid_types = {choice.value for choice in PendingAction.ActionType}
        if action_type not in valid_types or not isinstance(payload, dict):
            return Response({"detail": "Invalid pending action."}, status=status.HTTP_400_BAD_REQUEST)
        if not isinstance(message_id, str) or len(message_id) > 255:
            return Response({"detail": "Invalid message identifier."}, status=status.HTTP_400_BAD_REQUEST)
        pending, _ = PendingAction.objects.update_or_create(
            profile=profile,
            defaults={
                "action_type": action_type,
                "payload": payload,
                "original_message_id": message_id,
                "expires_at": timezone.now() + timedelta(minutes=30),
            },
        )
        return Response({"action_type": pending.action_type, "expires_at": pending.expires_at})

    def delete(self, request):
        profile = self._profile(request)
        if profile is not None:
            PendingAction.objects.filter(profile=profile).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class TransactionVoidView(APIView):
    """Idempotently mark an owned record void, retaining its audit history."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        message_id = request.headers.get("X-WhatsApp-Message-ID", "")
        if not message_id.strip() or len(message_id) > 255:
            return Response({"detail": "A valid WhatsApp message identifier is required."}, status=status.HTTP_400_BAD_REQUEST)
        reason = request.data.get("reason", "UNDO")
        if reason not in {"UNDO", "DELETE"}:
            return Response({"detail": "Invalid void reason."}, status=status.HTTP_400_BAD_REQUEST)

        try:
            with transaction.atomic():
                existing = ProcessedMessage.objects.select_related("transaction").filter(message_id=message_id).first()
                if existing:
                    return TransactionListCreateView._existing_message_response(existing, request.user.pk)
                record = Transaction.objects.select_for_update().filter(owner=request.user, pk=pk).first()
                if record is None:
                    return Response({"detail": "Transaction not found."}, status=status.HTTP_404_NOT_FOUND)
                if not record.is_voided:
                    record.is_voided = True
                    record.voided_at = timezone.now()
                    record.void_reason = reason
                    record.save(update_fields=["is_voided", "voided_at", "void_reason", "updated_at"])
                ProcessedMessage.objects.create(message_id=message_id, transaction=record)
                return Response(TransactionSerializer(record).data, status=status.HTTP_200_OK)
        except IntegrityError:
            existing = ProcessedMessage.objects.select_related("transaction").filter(message_id=message_id).first()
            if existing:
                return TransactionListCreateView._existing_message_response(existing, request.user.pk)
            raise


class AccountDataDeleteView(APIView):
    """Delete only the authenticated account after a confirmed WhatsApp request."""

    permission_classes = [permissions.IsAuthenticated]

    def delete(self, request):
        message_id = request.headers.get("X-WhatsApp-Message-ID", "")
        if not message_id.strip() or len(message_id) > 255:
            return Response({"detail": "A valid confirmation message identifier is required."}, status=status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            ProcessedMessage.objects.filter(transaction__owner=request.user).delete()
            request.user.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
