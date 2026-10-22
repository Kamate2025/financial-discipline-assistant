import hashlib
import hmac
import re

from django.conf import settings
from django.db import IntegrityError, transaction
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from django.contrib.auth import get_user_model

from .models import ProcessedMessage, Transaction, UserProfile, normalize_phone_number
from .serializers import TransactionSerializer


class TransactionListCreateView(generics.ListCreateAPIView):
    """List the authenticated user's transactions or create a new one.

    Ownership is always assigned from the authenticated user, never from the
    request payload. Users can only see and create their own records.
    """

    serializer_class = TransactionSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return Transaction.objects.filter(owner=self.request.user)

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
        self.perform_destroy(instance)
        return Response(status=status.HTTP_204_NO_CONTENT)


class WhatsAppOnboardingView(APIView):
    """Create or update the sender profile after the WhatsApp name prompt."""

    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        supplied_key = request.headers.get("X-Service-Key", "")
        expected_key = settings.DJANGO_SERVICE_KEY
        if not expected_key or not hmac.compare_digest(supplied_key, expected_key):
            return Response({"detail": "Invalid service credential."}, status=status.HTTP_403_FORBIDDEN)

        phone = request.data.get("phone_number", "")
        name = request.data.get("preferred_name", "")
        if not isinstance(phone, str) or not re.fullmatch(r"\+?\d{7,20}", phone):
            return Response({"phone_number": "Enter a valid international phone number."}, status=status.HTTP_400_BAD_REQUEST)
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 100:
            return Response({"preferred_name": "Enter a name of 1 to 100 characters."}, status=status.HTTP_400_BAD_REQUEST)

        phone = normalize_phone_number(phone)
        preferred_name = name.strip()
        profile = UserProfile.lookup_by_phone_number(phone)
        if profile:
            profile.preferred_name = preferred_name
            profile.save(update_fields=["preferred_name", "updated_at"])
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
                    preferred_name=preferred_name,
                )
        except IntegrityError:
            # Concurrent onboarding requests can race to create the same phone.
            profile = UserProfile.lookup_by_phone_number(phone)
            if profile is None:
                raise
            profile.preferred_name = preferred_name
            profile.save(update_fields=["preferred_name", "updated_at"])
            return Response({"created": False}, status=status.HTTP_200_OK)
        return Response({"created": True}, status=status.HTTP_201_CREATED)
