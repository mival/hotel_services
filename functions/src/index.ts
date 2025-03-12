/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import { onCall, onRequest } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { Database } from "./database.types";
import * as logger from "firebase-functions/logger";

import { createClient } from "@supabase/supabase-js";
import { defineSecret } from "firebase-functions/params";

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

const supabaseKey = defineSecret("SUPABASE_KEY");
const supabaseProjectId = defineSecret("SUPABASE_PROJECT_ID");

/**
 * ServiceError class
 * @param {string} message error message
 * @param {number} code error http code
 * @param {string} stack optional stack trace
 */
class ServiceError extends Error {
  /**
   * ServiceError constructor
   * @param {string} message error message
   * @param {number} code error http code
   * @param {string} stack optional stack trace
   */
  constructor(message: string, public code: number = 422, stack?: string) {
    super(message);
    this.stack = stack;
    this.code = code;
    this.name = "ServiceError";
  }

  /**
   * Converts the ServiceError instance to a JSON object
   * @return {Object} JSON representation of the error
   */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      stack: this.stack
    };
  }

  /**
   * Converts the ServiceError instance to a string representation
   * @return {string} String representation of the error
   */
  toString() {
    return `${this.code}: ${this.message}`;
  }
}

const filterService = async (
  services: string[],
  supabaseKey: string,
  supabaseProjectId: string
) => {
  if (!services.length) {
    throw new ServiceError("No services provided", 422);
  }

  if (!supabaseKey || !supabaseProjectId) {
    throw new ServiceError("Supabase configuration is not set", 422);
  }

  const supabaseUrl = `https://${supabaseProjectId}.supabase.co`;
  const supabase = createClient<Database>(supabaseUrl, supabaseKey);

  const query = supabase
    .from("hotels")
    .select(
      "hotel_id, hotels_services!inner(hotel_id, service_id, services!inner(name))"
    )
    .in("hotels_services.services.name", services as string[]);

  const { data, error } = await query;

  if (error) {
    throw new ServiceError(error.message, 500, error.stack);
  }

  const hotelData = data
    .map((hotel) => {
      return {
        hotel_id: hotel.hotel_id,
        services: hotel.hotels_services.map((service) => service.services.name),
      };
    })
    .filter((hotel) => {
      return (services as string[]).every((service: string) =>
        hotel.services.includes(service)
      );
    });

  return [...new Set(hotelData.map((hotel) => hotel.hotel_id))];
};

exports.serviceFilterHttp = onRequest(
  { region: ["europe-west4"], secrets: [supabaseKey, supabaseProjectId] },
  async (request, response) => {
    const { services = [] } = request.query;

    try {
      const unique = await filterService(
        services as string[],
        supabaseKey.value(),
        supabaseProjectId.value()
      );

      response.send(unique.map((hotelId) => ({ hotel_id: hotelId })));
    } catch (error: unknown) {
      const serviceError = error as ServiceError;
      response.status(serviceError.code).send(serviceError.toJSON());
    }
  }
);

exports.serviceFilter = onCall(
  { region: "europe-west4", secrets: [supabaseKey, supabaseProjectId] },
  async (request) => {
    const { services = [] } = request.data;

    const unique = await filterService(
      services as string[],
      supabaseKey.value(),
      supabaseProjectId.value()
    );

    return unique.map((hotelId) => ({ hotel_id: hotelId }));
  }
);

exports.hotelChanges = onDocumentWritten(
  {
    document: "hotels/{hotelId}",
    region: "europe-west4",
    secrets: [supabaseKey, supabaseProjectId],
  },
  async (event) => {
    if (!event.data) {
      return;
    }

    const apiKey = supabaseKey.value();
    const supabaseUrl = `https://${supabaseProjectId.value()}.supabase.co`;

    if (!apiKey || !supabaseUrl) {
      logger.error("Supabase configuration is not set");
      return;
    }

    const supabase = createClient<Database>(supabaseUrl, apiKey);
    const id = event.params.hotelId;
    const document = event.data.after.data();

    // delete
    if (!document) {
      try {
        await supabase.from("hotels").delete().match({ hotel_id: id });
        await supabase.from("hotels_services").delete().match({ hotel_id: id });
      } catch (error) {
        logger.error("error", error);
      }
      return;
    }

    try {
      await supabase
        .from("hotels")
        .upsert([{ hotel_id: id, updated_at: new Date().toISOString() }]);
      await supabase.from("hotels_services").delete().match({ hotel_id: id });

      await Promise.all(
        document.services.map((service: string) => {
          supabase
            .from("services")
            .select("id")
            .eq("name", service)
            .then((existingService) => {
              if (existingService.data?.length) {
                const existingServiceId = existingService.data[0].id;
                return supabase.from("hotels_services").upsert([
                  {
                    hotel_id: id,
                    service_id: existingServiceId,
                    updated_at: new Date().toISOString(),
                  },
                ]);
              } else {
                return supabase
                  .from("services")
                  .insert([{ name: service }])
                  .select("id")
                  .then((response) => {
                    if (!response.data) {
                      return;
                    }

                    return supabase.from("hotels_services").upsert([
                      {
                        hotel_id: id,
                        service_id: response.data[0].id,
                        updated_at: new Date().toISOString(),
                      },
                    ]);
                  });
              }
            });
        })
      );
    } catch (error) {
      logger.error("error", error);
    }
  }
);
