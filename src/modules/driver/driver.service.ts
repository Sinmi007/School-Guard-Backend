import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { HashingService } from '../../common/hashing/hashing.service';
import { TokenService, UserRole } from '../../common/auth/token.service';
import { LoginDto } from '../../common/auth/dto/login.dto';
import { RegisterDriverDto } from './dto/register-driver.dto';

@Injectable()
export class DriverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly token: TokenService,
  ) {}

  private readonly role: UserRole = 'DRIVER';

  async register(dto: RegisterDriverDto) {
    const school = await this.prisma.school.findUnique({
      where: { id: dto.schoolId },
    });
    if (!school) {
      throw new BadRequestException('Invalid schoolId');
    }

    if (dto.busId) {
      const bus = await this.prisma.bus.findUnique({
        where: { id: dto.busId },
      });
      if (!bus || bus.schoolId !== dto.schoolId) {
        throw new BadRequestException('Bus does not belong to this school');
      }
    }

    const exists = await this.prisma.driver.findUnique({
      where: { email: dto.email },
    });
    if (exists) {
      throw new ConflictException('Email already registered');
    }

    const password = await this.hashing.hash(dto.password);
    const driver = await this.prisma.driver.create({
      data: {
        email: dto.email,
        password,
        name: dto.name,
        schoolId: dto.schoolId,
        busId: dto.busId,
        phone: dto.phone,
      },
    });

    return this.buildResponse(driver);
  }

  async login(dto: LoginDto) {
    const driver = await this.prisma.driver.findUnique({
      where: { email: dto.email },
    });
    if (!driver) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await this.hashing.compare(dto.password, driver.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.buildResponse(driver);
  }

  async getProfile(id: string) {
    const driver = await this.prisma.driver.findUnique({ where: { id } });
    if (!driver) {
      throw new NotFoundException('Driver not found');
    }
    return this.toPublic(driver);
  }

  private buildResponse(driver: {
    id: string;
    email: string;
    name: string;
    schoolId: string;
    busId: string | null;
    phone: string | null;
  }) {
    return {
      accessToken: this.token.sign({
        sub: driver.id,
        email: driver.email,
        role: this.role,
        schoolId: driver.schoolId,
      }),
      user: this.toPublic(driver),
    };
  }

  private toPublic(driver: {
    id: string;
    email: string;
    name: string;
    schoolId: string;
    busId: string | null;
    phone: string | null;
  }) {
    return {
      id: driver.id,
      email: driver.email,
      name: driver.name,
      schoolId: driver.schoolId,
      busId: driver.busId,
      phone: driver.phone,
      role: this.role,
    };
  }
}
