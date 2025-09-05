import { RequestHandler } from "express";
import { Analytics } from "../utils/logger";
import { sqliteDb, BookingRecord } from "../utils/sqlite-db";

export interface BookingRequest {
  fanPreference?: string;
  selectedCelebrity: string;
  selectedEventType: string;
  budget: string;
  customAmount?: string;
  attendees: string;
  preferredDate: string;
  location: string;
  specialRequests: string;
  subscriptionId?: string;
  contactInfo: {
    name: string;
    email: string;
    phone: string;
    organization?: string;
  };
  privacyConsent: boolean;
}

export interface BookingResponse {
  success: boolean;
  message: string;
  bookingId?: string;
}

export const handleBookingSubmission: RequestHandler = async (req, res) => {
  const startTime = Date.now();

  try {
    const bookingData: BookingRequest = req.body;

    // Validate required fields
    if (
      !bookingData.selectedCelebrity ||
      !bookingData.selectedEventType ||
      !bookingData.budget
    ) {
      Analytics.trackBookingSubmission({
        success: false,
        hasSubscription: !!bookingData.subscriptionId,
        ip: req.ip,
      });

      return res.status(400).json({
        success: false,
        message: "Missing required booking information",
      });
    }

    if (
      !bookingData.contactInfo.name ||
      !bookingData.contactInfo.email ||
      !bookingData.contactInfo.phone
    ) {
      Analytics.trackBookingSubmission({
        success: false,
        hasSubscription: !!bookingData.subscriptionId,
        ip: req.ip,
      });

      return res.status(400).json({
        success: false,
        message: "Missing required contact information",
      });
    }

    if (!bookingData.privacyConsent) {
      Analytics.trackBookingSubmission({
        success: false,
        hasSubscription: !!bookingData.subscriptionId,
        ip: req.ip,
      });

      return res.status(400).json({
        success: false,
        message: "Privacy consent is required",
      });
    }

    // Generate a booking ID
    const bookingId = `HYBE-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

    // Save to SQLite database first
    const bookingRecord: Omit<BookingRecord, "id" | "created_at"> = {
      booking_id: bookingId,
      celebrity: bookingData.selectedCelebrity,
      full_name: bookingData.contactInfo.name,
      email: bookingData.contactInfo.email,
      phone: bookingData.contactInfo.phone,
      organization: bookingData.contactInfo.organization,
      event_type: bookingData.selectedEventType,
      event_date: bookingData.preferredDate,
      location: bookingData.location,
      budget_range: bookingData.budget,
      custom_amount: bookingData.customAmount
        ? parseFloat(bookingData.customAmount)
        : undefined,
      attendees: bookingData.attendees,
      special_requests: bookingData.specialRequests,
      subscription_id: bookingData.subscriptionId,
      privacy_consent: bookingData.privacyConsent,
      status: "pending",
    };

    try {
      await sqliteDb.saveBooking(bookingRecord);
      console.info(`✅ Booking saved to SQLite: ${bookingId}`);
    } catch (sqliteError) {
      console.error("❌ Failed to save booking to SQLite:", sqliteError);
      // Continue with Netlify submission even if SQLite fails
    }


    // Track successful booking analytics
    Analytics.trackBookingSubmission({
      artist: bookingData.selectedCelebrity,
      eventType: bookingData.selectedEventType,
      budget: bookingData.budget,
      hasSubscription: !!bookingData.subscriptionId,
      success: true,
      ip: req.ip,
    });

    // Track performance metrics
    Analytics.trackPerformance(
      "booking_submission_total",
      Date.now() - startTime,
      {
        bookingId,
        hasSubscription: !!bookingData.subscriptionId,
      },
    );

    const response: BookingResponse = {
      success: true,
      message:
        "Your booking request has been submitted successfully! Our team will contact you within 24 hours.",
      bookingId,
    };

    res.json(response);
  } catch (error) {
    Analytics.trackError(error as Error, "booking_submission", {
      ip: req.ip,
      hasSubscription: !!req.body?.subscriptionId,
      duration: Date.now() - startTime,
    });

    Analytics.trackBookingSubmission({
      success: false,
      hasSubscription: !!req.body?.subscriptionId,
      ip: req.ip,
    });

    res.status(500).json({
      success: false,
      message:
        "An error occurred while processing your booking request. Please try again.",
    });
  }
};
